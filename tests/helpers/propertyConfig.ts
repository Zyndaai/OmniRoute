import fc from "fast-check";

// Fixed seed (deterministic). FC_SEED=random picks a fresh one.
const PROPERTY_SEED = 42424242;
const PROPERTY_NUM_RUNS = 200;

const envSeed = process.env.FC_SEED;
export const seed = envSeed === "random" ? undefined : envSeed ? Number(envSeed) : PROPERTY_SEED;
export const numRuns = process.env.FC_NUM_RUNS
  ? Number(process.env.FC_NUM_RUNS)
  : PROPERTY_NUM_RUNS;

/** Apply the shared deterministic config; call once at top of each property test file. */
export function configureProperties(): void {
  fc.configureGlobal({ seed, numRuns });
}
