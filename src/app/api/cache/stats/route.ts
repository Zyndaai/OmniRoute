import { clearMemoryCache, getMemoryCacheStats } from "@/lib/semanticCache";
import { isAuthenticated, isCacheScopedKey } from "@/shared/utils/apiAuth";
import { CACHE_READ_SCOPE, CACHE_WRITE_SCOPE } from "@/shared/constants/managementScopes";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

export async function GET(req: Request) {
  if (!(await isAuthenticated(req)) && !(await isCacheScopedKey(req, CACHE_READ_SCOPE))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return Response.json(getMemoryCacheStats());
  } catch (error) {
    return Response.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  if (!(await isAuthenticated(req)) && !(await isCacheScopedKey(req, CACHE_WRITE_SCOPE))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    clearMemoryCache();
    return Response.json({ success: true, message: "Cache cleared" });
  } catch (error) {
    return Response.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
