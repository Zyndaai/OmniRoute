import { z } from "zod";

import { buildCacheHealthResponse } from "@/lib/usage/cacheHealth";

const querySchema = z.object({
  range: z.enum(["1h", "24h", "7d", "30d"]).default("24h"),
  model: z.string().min(1).max(200).optional(),
});

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const parsed = querySchema.safeParse({
      range: searchParams.get("range") ?? undefined,
      model: searchParams.get("model") || undefined,
    });

    if (!parsed.success) {
      return Response.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid query parameters" },
        { status: 400 }
      );
    }

    return Response.json(await buildCacheHealthResponse(parsed.data));
  } catch (error) {
    // Never echo the error: the message can carry the DATA_DIR path and the
    // SQL text. Details go to the server log, the caller gets a fixed string.
    console.error("Error building cache health summary:", error);
    return Response.json({ error: "Failed to build cache health summary" }, { status: 500 });
  }
}
