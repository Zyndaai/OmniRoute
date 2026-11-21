import { z } from "zod";

import { buildComboHealthResponse } from "@/lib/usage/comboHealth";

const querySchema = z.object({
  range: z.enum(["1h", "24h", "7d", "30d"]),
  comboId: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    .optional(),
});

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const parsedQuery = querySchema.safeParse({
      range: searchParams.get("range"),
      comboId: searchParams.get("comboId") || undefined,
    });

    if (!parsedQuery.success) {
      return Response.json(
        {
          error: parsedQuery.error.issues[0]?.message ?? "Invalid query parameters",
        },
        { status: 400 }
      );
    }

    const response = await buildComboHealthResponse(parsedQuery.data);
    if (parsedQuery.data.comboId && response.combos.length === 0) {
      return Response.json({ error: "Combo not found" }, { status: 404 });
    }

    return Response.json(response);
  } catch (error) {
    console.error("Error fetching combo health:", error);
    return Response.json({ error: "Failed to fetch combo health" }, { status: 500 });
  }
}
