/**
 * Normalize any thrown/rejected value into a real `Error` instance.
 *
 * Boot failure handling reads and rewrites `err.message` (to prefix context) on whatever the
 * boot sequence (`src/server/boot.ts`) rejects with, assuming it is always an `Error`. If a raw
 * non-Error primitive bubbles up instead (e.g. sql.js's WASM adapter throws the bare string
 * `"Database closed"` — see `./db/adapters/sqljsAdapter.ts`), assigning `message` throws
 * `TypeError: Cannot create property 'message' on string '...'` in strict mode, masking the
 * original error and crashing the whole server on every boot (#6560).
 * Normalizing before the value leaves our code guarantees callers always receive
 * something `.message`-assignable.
 *
 * Deliberately dependency-free (no imports) so both the outermost boot boundary
 * (`runBoot`) and the boot sequence in `src/server/boot.ts` can import it
 * statically, without relying on a dynamic import of the boot module that could itself be
 * the thing that failed to load (#10171).
 */
export function normalizeBootError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
