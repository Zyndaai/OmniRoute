import { getDefaultPricing } from "@/shared/constants/pricing";

/**
 * GET /api/pricing/defaults
 * Get default pricing configuration
 */
export async function GET() {
  try {
    const defaultPricing = getDefaultPricing();
    return Response.json(defaultPricing);
  } catch (error) {
    console.error("Error fetching default pricing:", error);
    return Response.json({ error: "Failed to fetch default pricing" }, { status: 500 });
  }
}
