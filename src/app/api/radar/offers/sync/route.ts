import { syncRadarOffers } from "@/lib/radar/offersSync";
import { handleCorsOptions } from "@/shared/utils/cors";
import { handleRadarFeedSync } from "../../syncHandler";

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function POST(request: Request) {
  return handleRadarFeedSync(request, syncRadarOffers, "Radar offers sync failed");
}
