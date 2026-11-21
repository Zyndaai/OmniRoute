import { readFile } from "fs/promises";
import path from "path";

export async function GET() {
  try {
    const filePath = path.join(process.cwd(), "docs/guides/CODEX-CLI-CONFIGURATION.md");
    const content = await readFile(filePath, "utf-8");
    return Response.json({ content });
  } catch {
    return Response.json({ error: "Guide not found" }, { status: 404 });
  }
}
