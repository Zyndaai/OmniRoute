import { z } from "zod";

import {
  clearLocalCorpusRoot,
  getLocalCorpusConfig,
  setLocalCorpusRoot,
} from "@/lib/db/localCorpus";
import { canonicalizeLocalCorpusRoot } from "@/lib/localCorpus";
import {
  getConfiguredLocalCorpusStatus,
  resetLocalCorpusIndex,
} from "@/lib/localCorpus/configured";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

const localCorpusSchema = z
  .object({
    rootPath: z.string().trim().min(1).max(4_096),
  })
  .strict();

export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const config = await getLocalCorpusConfig();
    return Response.json({
      ...config,
      status: await getConfiguredLocalCorpusStatus(),
    });
  } catch (error) {
    return Response.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = localCorpusSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Missing or invalid rootPath", details: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const rootPath = await canonicalizeLocalCorpusRoot(parsed.data.rootPath);
    await setLocalCorpusRoot(rootPath);
    resetLocalCorpusIndex();
    return Response.json({
      configured: true,
      rootPath,
      message: "Local corpus root saved. Content remains on the local filesystem.",
    });
  } catch (error) {
    return Response.json({ error: sanitizeErrorMessage(error) }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await clearLocalCorpusRoot();
    resetLocalCorpusIndex();
    return Response.json({
      configured: false,
      message: "Local corpus disconnected. Source files were not modified.",
    });
  } catch (error) {
    return Response.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
