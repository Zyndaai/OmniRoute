import { db } from "@/lib/db/pg";

type JsonRecord = Record<string, unknown>;

export interface OneproxyProxyRecord {
  id: string;
  name: string;
  type: string;
  host: string;
  port: number;
  region: string | null;
  notes: string | null;
  status: string;
  source: string;
  qualityScore: number | null;
  latencyMs: number | null;
  anonymity: string | null;
  googleAccess: boolean;
  lastValidated: string | null;
  countryCode: string | null;
  createdAt: string;
  updatedAt: string;
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function mapProxyRow(row: unknown): OneproxyProxyRecord {
  const r = toRecord(row);
  return {
    id: typeof r.id === "string" ? r.id : "",
    name: typeof r.name === "string" ? r.name : "",
    type: typeof r.type === "string" ? r.type : "http",
    host: typeof r.host === "string" ? r.host : "",
    port: Number(r.port) || 0,
    region: typeof r.region === "string" ? r.region : null,
    notes: typeof r.notes === "string" ? r.notes : null,
    status: typeof r.status === "string" ? r.status : "active",
    source: typeof r.source === "string" ? r.source : "oneproxy",
    qualityScore: typeof r.quality_score === "number" ? r.quality_score : null,
    latencyMs: typeof r.latency_ms === "number" ? r.latency_ms : null,
    anonymity: typeof r.anonymity === "string" ? r.anonymity : null,
    googleAccess: r.google_access === true || r.google_access === 1,
    lastValidated: typeof r.last_validated === "string" ? r.last_validated : null,
    countryCode: typeof r.country_code === "string" ? r.country_code : null,
    createdAt: typeof r.created_at === "string" ? r.created_at : "",
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : "",
  };
}

export async function listOneproxyProxies(options?: {
  protocol?: string;
  countryCode?: string;
  minQuality?: number;
  limit?: number;
}): Promise<OneproxyProxyRecord[]> {
  let sql = "SELECT * FROM proxy_registry WHERE source = 'oneproxy' AND status = 'active'";
  const params: unknown[] = [];

  if (options?.protocol) {
    params.push(options.protocol);
    sql += ` AND type = $${params.length}`;
  }
  if (options?.countryCode) {
    params.push(options.countryCode);
    sql += ` AND country_code = $${params.length}`;
  }
  if (options?.minQuality != null) {
    params.push(options.minQuality);
    sql += ` AND quality_score >= $${params.length}`;
  }

  // NULLS LAST keeps the SQLite ordering (NULL sorted smallest).
  sql += " ORDER BY quality_score DESC NULLS LAST, last_validated DESC NULLS LAST";

  if (options?.limit) {
    params.push(options.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const rows = await db().query(sql, params);
  return rows.map(mapProxyRow);
}
