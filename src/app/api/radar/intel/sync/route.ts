import { syncRadarIntel } from "@/lib/radar/intelSync";
import { handleCorsOptions } from "@/shared/utils/cors";
import { handleRadarFeedSync } from "../../syncHandler";

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function POST(request: Request) {
  return handleRadarFeedSync(request, syncRadarIntel, "Radar Intel sync failed");
}
