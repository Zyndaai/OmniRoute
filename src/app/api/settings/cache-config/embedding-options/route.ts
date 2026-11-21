import { isAuthenticated } from "@/shared/utils/apiAuth";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { getEmbeddingOptions } from "../embeddingOptions";

export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const providers = await getEmbeddingOptions();
    return Response.json({ providers });
  } catch (error: unknown) {
    const message = sanitizeErrorMessage(error);
    return Response.json({ error: message }, { status: 500 });
  }
}
