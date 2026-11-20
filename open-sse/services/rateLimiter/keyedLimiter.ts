/**
 * Rate limiter for one limiter key (a provider connection, or one model of it).
 *
 * Replaces Bottleneck, which needed two monkey-patches, a wedge watchdog and an internal
 * queue-surgery helper to behave. This design has no heartbeat and no hidden state:
 *
 * - A local FIFO queue of waiting jobs. Only the head is ever admitted, so order is kept.
 * - A `SlotState` decides whether the head may start now and, if not, how long to wait.
 *   `MemorySlotState` (below) keeps that state in this process; `RedisSlotState`
 *   (./redisSlotState.ts) keeps it in Redis so every process of a cluster shares one limit.
 * - When the head cannot start, one timer is set for exactly the wait the state returned.
 *   A finished job, a cancelled head or a settings change pumps the queue again. Nothing
 *   polls on a heartbeat, so nothing can stall with capacity free.
 *
 * Settings keep the vocabulary the rate-limit manager already uses: `minTime` (spacing
 * between starts), `maxConcurrent`, and a token budget (`reservoir`) reset to
 * `reservoirRefreshAmount` every `reservoirRefreshInterval` ms. `null` or missing means
 * "no limit" for each.
 */

export interface LimiterSettings {
  maxConcurrent?: number | null;
  minTime?: number | null;
  reservoir?: number | null;
  reservoirRefreshAmount?: number | null;
  reservoirRefreshInterval?: number | null;
}

/** A grant carries the slot to release; a refusal carries the wait and what caused it. */
export interface Admission {
  granted: boolean;
  slot?: string;
  waitMs?: number;
  reason?: "spacing" | "reservoir" | "concurrency";
}

/** Where a limiter's live state (running jobs, last start, tokens) lives. */
export interface SlotState {
  /**
   * May one more job start now? A grant takes a token and the spacing slot and holds a
   * concurrency slot until `release`. `leaseMs` bounds how long a slot can be held by a
   * process that dies without releasing it (shared state only).
   * `waitMs` is the exact wait when the state knows it, Infinity when only a local event
   * (a release, a settings change) can free capacity.
   */
  acquire(settings: LimiterSettings, leaseMs: number): Admission | Promise<Admission>;
  release(slot: string): void | Promise<void>;
  /**
   * Applies a settings change: a `reservoir` value sets the tokens; a refresh amount or
   * interval restarts the refill clock from now.
   */
  apply(updates: LimiterSettings): void | Promise<void>;
  /** Current tokens, or null when the budget is unlimited. */
  tokens(): number | null | Promise<number | null>;
  /** Forget shared state so the next limiter for this key starts from its settings. */
  discard(): void | Promise<void>;
}

/** Rejects a job that outlived its `expiration` after it started (the work keeps running). */
export class LimiterExecutionTimeoutError extends Error {
  constructor(readonly expirationMs: number) {
    super(`This job timed out after ${expirationMs} ms.`);
    this.name = "LimiterExecutionTimeoutError";
  }
}

/** Rejects a queued job that was cancelled or dropped before it started. */
export class LimiterJobDroppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimiterJobDroppedError";
  }
}

export interface ScheduleOptions {
  id?: string;
  /** Execution deadline in ms, counted from the moment the job starts (not queue wait). */
  expiration?: number;
}

export interface LimiterCounts {
  QUEUED: number;
  RUNNING: number;
  EXECUTING: number;
  DONE: number;
}

interface Job {
  id: string;
  fn: () => Promise<unknown>;
  expiration?: number;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/** How long a shared concurrency slot outlives a job that set no expiration. */
const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const LEASE_MARGIN_MS = 30_000;

export const isUnlimited = (value: number | null | undefined): boolean =>
  value === null || value === undefined || !Number.isFinite(value);

let jobSeq = 0;

export class KeyedLimiter {
  private settings: LimiterSettings;
  private readonly queue: Job[] = [];
  private executing = 0;
  private done = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pumping = false;
  private repump = false;
  private stopped = false;

  constructor(
    readonly key: string,
    settings: LimiterSettings,
    private readonly state: SlotState
  ) {
    this.settings = { ...settings };
  }

  /** The settings as configured (account-wide, never a per-process share). */
  getSettings(): LimiterSettings {
    return { ...this.settings };
  }

  schedule<T>(options: ScheduleOptions, fn: () => Promise<T>): Promise<T> {
    if (this.stopped) {
      return Promise.reject(new LimiterJobDroppedError("This limiter has been stopped."));
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        id: options.id ?? `job-${++jobSeq}`,
        fn,
        expiration: options.expiration,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.pump();
    });
  }

  /** Removes a job that is still queued. False once it started, or if it was never here. */
  cancel(jobId: string, message = "rate-limit-queued-job-abandoned"): boolean {
    const index = this.queue.findIndex((job) => job.id === jobId);
    if (index < 0) return false;
    const [job] = this.queue.splice(index, 1);
    job.reject(new LimiterJobDroppedError(message));
    if (index === 0) this.pump();
    return true;
  }

  updateSettings(updates: LimiterSettings): void {
    this.settings = { ...this.settings, ...updates };
    // Applied synchronously so a job scheduled right after this call already sees it
    // (an async state orders its own writes before later acquires).
    let applied: void | Promise<void>;
    try {
      applied = this.state.apply(updates);
    } catch {
      applied = undefined;
    }
    void Promise.resolve(applied).then(
      () => this.pump(),
      () => this.pump()
    );
  }

  counts(): LimiterCounts {
    return { QUEUED: this.queue.length, RUNNING: 0, EXECUTING: this.executing, DONE: this.done };
  }

  currentReservoir(): Promise<number | null> {
    return Promise.resolve(this.state.tokens());
  }

  /** Nothing queued and nothing running in this process. */
  isIdle(): boolean {
    return this.queue.length === 0 && this.executing === 0;
  }

  /** Forget shared state (Redis) so the next limiter for this key starts fresh. */
  discardState(): Promise<void> {
    return Promise.resolve(this.state.discard());
  }

  /** Rejects every queued job; running jobs finish. Later schedules are refused. */
  stop(message = "This limiter has been stopped."): void {
    this.stopped = true;
    this.clearTimer();
    for (const job of this.queue.splice(0)) job.reject(new LimiterJobDroppedError(message));
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private pump(): void {
    if (this.pumping) {
      this.repump = true;
      return;
    }
    this.pumping = true;
    this.clearTimer();
    void this.drain().finally(() => {
      this.pumping = false;
      if (this.repump) {
        this.repump = false;
        this.pump();
      }
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.stopped) {
      const head = this.queue[0];
      const leaseMs =
        (head.expiration && head.expiration > 0 ? head.expiration : DEFAULT_LEASE_MS) +
        LEASE_MARGIN_MS;
      let admission: Admission;
      try {
        admission = await this.state.acquire(this.settings, leaseMs);
      } catch {
        // The limit is a safety net: a state that cannot answer lets the request through
        // rather than stall every caller (RedisSlotState already logs and fails open).
        admission = { granted: true, slot: "" };
      }
      // The head may have been cancelled while an async state answered.
      if (this.queue[0] !== head) {
        if (admission.granted && admission.slot) void this.releaseSlot(admission.slot);
        continue;
      }
      if (!admission.granted) {
        if (Number.isFinite(admission.waitMs)) {
          this.timer = setTimeout(() => this.pump(), Math.max(1, Math.ceil(admission.waitMs)));
          this.timer.unref?.();
        }
        // An infinite wait is ended by the next release or settings change.
        return;
      }
      this.queue.shift();
      this.start(head, admission.slot ?? "");
    }
  }

  private releaseSlot(slot: string): Promise<void> {
    if (!slot) return Promise.resolve();
    return Promise.resolve()
      .then(() => this.state.release(slot))
      .catch(() => undefined);
  }

  private start(job: Job, slot: string): void {
    this.executing++;
    let settled = false;
    let expiry: ReturnType<typeof setTimeout> | null = null;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      if (expiry) clearTimeout(expiry);
      this.executing--;
      this.done++;
      outcome();
      void this.releaseSlot(slot).then(() => this.pump());
    };
    if (job.expiration && job.expiration > 0) {
      const expirationMs = job.expiration;
      expiry = setTimeout(
        () => finish(() => job.reject(new LimiterExecutionTimeoutError(expirationMs))),
        expirationMs
      );
      expiry.unref?.();
    }
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(job.fn());
    } catch (error) {
      result = Promise.reject(error);
    }
    result.then(
      (value) => finish(() => job.resolve(value)),
      (error) => finish(() => job.reject(error))
    );
  }
}

/**
 * Limiter state kept in this process. `share` scales the limits to this process's part
 * of the account's budget (../clusterShare.ts; 1 standalone).
 */
export class MemorySlotState implements SlotState {
  private running = 0;
  private lastStart = Number.NEGATIVE_INFINITY;
  private tokensLeft: number | null = null;
  private refreshAmount: number | null = null;
  private refreshInterval: number | null = null;
  private nextRefreshAt = 0;
  private slotSeq = 0;
  private readonly open = new Set<string>();

  constructor(
    initial: LimiterSettings,
    private readonly scale: (settings: LimiterSettings) => LimiterSettings = (s) => s,
    private readonly now: () => number = Date.now
  ) {
    this.apply(initial);
  }

  apply(updates: LimiterSettings): void {
    const scaled = this.scale(updates);
    if ("reservoir" in updates) {
      this.tokensLeft = isUnlimited(scaled.reservoir) ? null : (scaled.reservoir as number);
    }
    if ("reservoirRefreshAmount" in updates) {
      this.refreshAmount = isUnlimited(scaled.reservoirRefreshAmount)
        ? null
        : (scaled.reservoirRefreshAmount as number);
    }
    if ("reservoirRefreshInterval" in updates) {
      const interval = updates.reservoirRefreshInterval;
      this.refreshInterval =
        typeof interval === "number" && Number.isFinite(interval) && interval > 0 ? interval : null;
    }
    const refreshChanged =
      "reservoirRefreshAmount" in updates || "reservoirRefreshInterval" in updates;
    if (refreshChanged && this.refreshInterval !== null) {
      this.nextRefreshAt = this.now() + this.refreshInterval;
    }
  }

  private refill(now: number): void {
    if (this.refreshInterval === null || this.refreshAmount === null) return;
    if (now < this.nextRefreshAt) return;
    this.tokensLeft = this.refreshAmount;
    const missed = Math.floor((now - this.nextRefreshAt) / this.refreshInterval) + 1;
    this.nextRefreshAt += missed * this.refreshInterval;
  }

  acquire(settings: LimiterSettings): Admission {
    const now = this.now();
    const scaled = this.scale(settings);
    const maxConcurrent = isUnlimited(scaled.maxConcurrent)
      ? Infinity
      : (scaled.maxConcurrent as number);
    if (this.running >= maxConcurrent) {
      return { granted: false, waitMs: Infinity, reason: "concurrency" };
    }
    this.refill(now);
    if (this.tokensLeft !== null && this.tokensLeft <= 0) {
      const refills = this.refreshInterval !== null && this.refreshAmount !== null;
      return {
        granted: false,
        waitMs: refills ? this.nextRefreshAt - now : Infinity,
        reason: "reservoir",
      };
    }
    const minTime = typeof scaled.minTime === "number" && scaled.minTime > 0 ? scaled.minTime : 0;
    const spacingWait = this.lastStart + minTime - now;
    if (spacingWait > 0) return { granted: false, waitMs: spacingWait, reason: "spacing" };

    this.running++;
    this.lastStart = now;
    if (this.tokensLeft !== null) this.tokensLeft--;
    const slot = `m${++this.slotSeq}`;
    this.open.add(slot);
    return { granted: true, slot };
  }

  release(slot: string): void {
    if (this.open.delete(slot)) this.running--;
  }

  tokens(): number | null {
    this.refill(this.now());
    return this.tokensLeft;
  }

  discard(): void {}
}
