import { getDiversityReport } from "../../../../../open-sse/services/autoCombo/providerDiversity";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

export async function GET() {
  try {
    const report = getDiversityReport();
    return Response.json(report);
  } catch (error: unknown) {
    return Response.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
