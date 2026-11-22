import { apiJson, apiRequest } from "@/server/routing/dashboardApi.server";

export interface RadarRead<T> {
  /** HTTP status of the radar route; 404 means the Radar feature flag is off. */
  status: number;
  /** The JSON body when the call succeeded, otherwise null. */
  body: T | null;
}

/**
 * A radar read that keeps the status: the pages treat 404 (flag off) differently from other
 * errors. A 401 still redirects to the login page.
 */
export async function radarRead<T>(path: string): Promise<RadarRead<T>> {
  const response = await apiRequest(path);
  // apiJson() turns a 401 into the login redirect; the replay is the same request, so it throws.
  if (response.status === 401) await apiJson(path);
  if (!response.ok) return { status: response.status, body: null };
  const text = await response.text();
  try {
    return { status: response.status, body: text ? (JSON.parse(text) as T) : null };
  } catch {
    return { status: response.status, body: null };
  }
}
