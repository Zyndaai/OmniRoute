import { isLocalRequestAllowed } from "@/lib/security/localEndpoints";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

import {
  REDIS_CONTAINER_NAME,
  detectRedisContainerRuntime,
  redisRuntimeUnavailableResponse,
  runRedisRuntimeCommand,
} from "../redisRuntime";

export async function POST() {
  const guard = isLocalRequestAllowed();
  if (guard.allowed === false) {
    return Response.json({ error: guard.reason }, { status: 403 });
  }

  const runtime = await detectRedisContainerRuntime();
  if (!runtime) {
    return redisRuntimeUnavailableResponse();
  }

  try {
    const { stdout, stderr } = await runRedisRuntimeCommand(
      runtime,
      ["stop", REDIS_CONTAINER_NAME],
      15_000
    );
    return Response.json({
      ok: true,
      runtime,
      name: REDIS_CONTAINER_NAME,
      stdout,
      stderr,
    });
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    // exit code != 0 from `stop` typically means "not running" — surface that as ok=false but don't 500
    if (rawMessage.includes("no container with name") || rawMessage.includes("No such container")) {
      return Response.json({ ok: false, runtime, error: "not running" }, { status: 404 });
    }
    // Hard Rule #12: never put a raw execFile error (command line + paths) in the body.
    return Response.json({ ok: false, runtime, error: sanitizeErrorMessage(err) }, { status: 500 });
  }
}
