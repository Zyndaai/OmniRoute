/**
 * Database module: InspectorSessions
 * CRUD + snapshot for inspector_sessions and inspector_session_requests tables.
 */

import { randomUUID } from "crypto";
import { db } from "./pg";
import { jsonTextParam } from "./pgJsonText";
import type { InspectorSessionRow } from "./_rowTypes";
import { InterceptedRequestSchema } from "../../mitm/inspector/types";
import type { InterceptedRequest } from "../../mitm/inspector/types";

interface InspectorSessionDbRow {
  id: string;
  name: string | null;
  started_at: string;
  ended_at: string | null;
  request_count: number;
  profile: string | null;
}

function mapSessionRow(row: InspectorSessionDbRow): InspectorSessionRow {
  return {
    id: row.id,
    name: row.name,
    started_at: row.started_at,
    ended_at: row.ended_at,
    request_count: row.request_count,
    profile: row.profile as "llm" | "custom" | "all" | null,
  };
}

export async function createSession(opts?: {
  name?: string;
  profile?: "llm" | "custom" | "all";
}): Promise<{ id: string; started_at: string }> {
  const id = randomUUID();
  const started_at = new Date().toISOString();

  await db().execute(
    `INSERT INTO inspector_sessions (id, name, started_at, profile) VALUES ($1, $2, $3, $4)`,
    [id, opts?.name ?? null, started_at, opts?.profile ?? null]
  );

  return { id, started_at };
}

export async function stopSession(id: string): Promise<void> {
  await db().execute(`UPDATE inspector_sessions SET ended_at = $1 WHERE id = $2`, [
    new Date().toISOString(),
    id,
  ]);
}

export async function renameSession(id: string, name: string): Promise<void> {
  await db().execute(`UPDATE inspector_sessions SET name = $1 WHERE id = $2`, [name, id]);
}

export async function listSessions(): Promise<InspectorSessionRow[]> {
  const rows = await db().query<InspectorSessionDbRow>(
    `SELECT id, name, profile, started_at, ended_at, request_count
       FROM inspector_sessions ORDER BY started_at DESC`
  );
  return rows.map(mapSessionRow);
}

export async function getSession(id: string): Promise<InspectorSessionRow | null> {
  const row = await db().queryOne<InspectorSessionDbRow>(
    `SELECT id, name, profile, started_at, ended_at, request_count
       FROM inspector_sessions WHERE id = $1`,
    [id]
  );
  return row ? mapSessionRow(row) : null;
}

export async function appendSessionRequest(sessionId: string, payload: string): Promise<number> {
  return db().transaction(async (tx) => {
    // Serialise appends per session so MAX(seq)+1 cannot hand out the same seq twice.
    await tx.execute(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`inspector:${sessionId}`]);
    const seqRow = await tx.queryOne<{ next_seq: number }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM inspector_session_requests WHERE session_id = $1`,
      [sessionId]
    );
    const nextSeq = Number(seqRow?.next_seq ?? 1);

    await tx.execute(
      `INSERT INTO inspector_session_requests (session_id, seq, payload) VALUES ($1, $2, $3::jsonb)`,
      [sessionId, nextSeq, jsonTextParam(payload)]
    );
    await tx.execute(
      `UPDATE inspector_sessions SET request_count = request_count + 1 WHERE id = $1`,
      [sessionId]
    );
    return nextSeq;
  });
}

export async function getSessionRequests(
  sessionId: string
): Promise<Array<{ seq: number; payload: string }>> {
  const rows = await db().query<{ seq: number; payload: string }>(
    `SELECT seq, payload::text AS payload FROM inspector_session_requests
      WHERE session_id = $1 ORDER BY seq ASC`,
    [sessionId]
  );
  return rows.map((r) => ({ seq: r.seq, payload: r.payload }));
}

export async function deleteSession(id: string): Promise<void> {
  await db().transaction(async (tx) => {
    // No foreign key between the tables: remove the requests explicitly.
    await tx.execute(`DELETE FROM inspector_session_requests WHERE session_id = $1`, [id]);
    await tx.execute(`DELETE FROM inspector_sessions WHERE id = $1`, [id]);
  });
}

/**
 * Return a parsed + validated snapshot of all requests for the given session,
 * sorted by ascending seq.
 *
 * Returns null when the session does not exist.
 * Rows whose payload fails InterceptedRequestSchema validation are silently
 * skipped (defensive — protects callers from corrupt/partial rows).
 */
export async function snapshotSession(sessionId: string): Promise<InterceptedRequest[] | null> {
  const session = await getSession(sessionId);
  if (session === null) return null;

  const rawRows = await getSessionRequests(sessionId);

  const results: InterceptedRequest[] = [];
  for (const row of rawRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const result = InterceptedRequestSchema.safeParse(parsed);
    if (result.success) {
      results.push(result.data as InterceptedRequest);
    }
  }

  return results;
}
