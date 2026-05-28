import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { crypto } from "jsr:@std/crypto@0.224.0";
import { encodeHex } from "jsr:@std/encoding@0.224.0/hex";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const LIBRE_EMAIL = Deno.env.get("LIBREVIEW_EMAIL") ?? "Storagegox654@gmail.com";
const LIBRE_PASSWORD = Deno.env.get("LIBREVIEW_PASSWORD") ?? "Jezismina11!";
const LIBRE_API = "https://api-eu.libreview.io";

const LLU_HEADERS = {
  "Content-Type": "application/json",
  "product": "llu.android",
  "version": "4.12.0",
  "Accept-Encoding": "gzip",
  "cache-control": "no-cache",
  "connection": "Keep-Alive",
};

type RawReading = { Timestamp: string; Value: number; TrendArrow: number };

function mapTrend(trend: number): string {
  const map: Record<number, string> = {
    1: "falling_quickly", 2: "falling", 3: "falling_slowly",
    4: "flat", 5: "rising_slowly", 6: "rising", 7: "rising_quickly",
  };
  return map[trend] ?? "flat";
}

async function sha256hex(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return encodeHex(new Uint8Array(hash));
}

interface LoginResult {
  token: string;
  baseUrl: string;
  accountId: string;
  userId: string;
}

async function libreLogin(): Promise<LoginResult> {
  const doLogin = async (baseUrl: string) => {
    const res = await fetch(`${baseUrl}/llu/auth/login`, {
      method: "POST",
      headers: LLU_HEADERS,
      body: JSON.stringify({ email: LIBRE_EMAIL, password: LIBRE_PASSWORD }),
    });
    const text = await res.text();
    let json: Record<string, unknown>;
    try { json = JSON.parse(text); } catch { throw new Error(`Login parse fout: ${text.slice(0, 200)}`); }
    if (!res.ok) throw new Error(`Login mislukt (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  };

  let json = await doLogin(LIBRE_API);
  let baseUrl = LIBRE_API;

  if ((json.data as Record<string, unknown>)?.redirect) {
    const region = (json.data as Record<string, unknown>).region as string;
    baseUrl = `https://api-${region}.libreview.io`;
    json = await doLogin(baseUrl);
  }

  const data = json.data as Record<string, unknown>;
  const userId = (data.user as Record<string, unknown>).id as string;
  const token = (data.authTicket as Record<string, unknown>).token as string;
  const accountId = await sha256hex(userId);

  return { token, baseUrl, accountId, userId };
}

function authHeaders(token: string, accountId: string) {
  return { ...LLU_HEADERS, "Authorization": `Bearer ${token}`, "account-id": accountId };
}

async function apiGet(token: string, accountId: string, baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: authHeaders(token, accountId) });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, ok: res.ok, json, text };
}

// Extraheer readings uit het lsl response — probeer alle bekende structuren
function extractLslReadings(json: unknown): RawReading[] {
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;

  // Structuur 1: { data: { graphData: [...] } }
  const data = obj.data;
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.graphData) && d.graphData.length > 0) {
      const readings = d.graphData as RawReading[];
      // voeg currentMeasurement toe indien aanwezig
      const cur = d.currentMeasurement as RawReading | undefined;
      if (cur?.Timestamp) readings.push(cur);
      return readings;
    }

    // Structuur 2: { data: [...] } (platte array)
    if (Array.isArray(data)) return data as RawReading[];

    // Structuur 3: { data: { data: [...] } }
    if (Array.isArray(d.data)) return d.data as RawReading[];

    // Structuur 4: { data: { periods: [{ data: [...] }] } }
    if (Array.isArray(d.periods)) {
      return (d.periods as Array<{ data?: RawReading[] }>).flatMap(p => p.data ?? []);
    }

    // Structuur 5: { data: { results: [...] } }
    if (Array.isArray(d.results)) return d.results as RawReading[];

    // Structuur 6: { data: { connection: {...}, graphData: [...] } } (zelfde als /llu/graph)
    const connection = d.connection as Record<string, unknown> | undefined;
    if (connection?.glucoseMeasurement) {
      const pts: RawReading[] = Array.isArray(d.graphData) ? d.graphData as RawReading[] : [];
      pts.push(connection.glucoseMeasurement as RawReading);
      if (pts.length > 0) return pts;
    }
  }

  // Structuur 7: root-level array
  if (Array.isArray(json)) return json as RawReading[];

  return [];
}

async function collectReadings(
  token: string, accountId: string, baseUrl: string, userId: string
): Promise<{ readings: RawReading[]; debugInfo: string }> {
  const debug: string[] = [];

  // Stap 1: LibreLinkUp verbindingen (werkt voor follower-accounts)
  const connRes = await apiGet(token, accountId, baseUrl, "/llu/connections");
  debug.push(`connections=${connRes.status}`);

  if (connRes.ok) {
    const connections = ((connRes.json as Record<string, unknown>).data as Array<{ patientId: string }>) ?? [];
    debug.push(`conn_count=${connections.length}`);
    const readings: RawReading[] = [];
    for (const conn of connections) {
      const graphRes = await apiGet(token, accountId, baseUrl, `/llu/connections/${conn.patientId}/graph`);
      if (!graphRes.ok) continue;
      const graph = (graphRes.json as Record<string, unknown>).data as Record<string, unknown>;
      const pts: RawReading[] = (graph?.graphData as RawReading[]) ?? [];
      const cur = (graph?.connection as Record<string, unknown>)?.glucoseMeasurement as RawReading | undefined;
      if (cur?.Timestamp) pts.push(cur);
      readings.push(...pts);
    }
    if (readings.length > 0) return { readings, debugInfo: debug.join(", ") };
  }

  // Stap 2: eigen sensordata via lsl/api — probeer meerdere paden
  const lslPaths = [
    `/lsl/api/measurements/GetPatientGlucoseMeasurements?country=NL&patientId=${userId}`,
    `/lsl/api/measurements/GetPatientGlucoseMeasurements?patientId=${userId}`,
    `/lsl/api/measurements`,
    `/lsl/api/patients/${userId}/glucosemeasurements`,
    `/llu/users/${userId}/graph`,
  ];

  for (const path of lslPaths) {
    const res = await apiGet(token, accountId, baseUrl, path);
    const key = path.split("?")[0].split("/").slice(-2).join("/");
    debug.push(`${key}=${res.status}`);
    if (res.ok) {
      const readings = extractLslReadings(res.json);
      if (readings.length > 0) {
        debug.push(`found=${readings.length}`);
        return { readings, debugInfo: debug.join(", ") };
      }
      // 200 maar geen data — log de response structuur voor diagnose
      debug.push(`empty_body=${JSON.stringify(res.json).slice(0, 150)}`);
    }
  }

  throw new Error(
    `Geen sensordata gevonden. Statuses: ${debug.join(", ")}. ` +
    `Oplossing: open de FreeStyle LibreLink app, accepteer eventuele nieuwe gebruiksvoorwaarden, ` +
    `en zorg dat LibreLink Up is ingeschakeld onder Verbindingen.`
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { token, baseUrl, accountId, userId } = await libreLogin();
    const { readings: graphData, debugInfo } = await collectReadings(token, accountId, baseUrl, userId);

    const rows = graphData
      .filter(pt => pt.Timestamp && pt.Value)
      .map((pt) => ({
        timestamp: new Date(pt.Timestamp.replace(" ", "T")).toISOString(),
        value_mmol: parseFloat((pt.Value / 18.018).toFixed(2)),
        raw_value: pt.Value,
        unit: "mg/dL",
        trend: mapTrend(pt.TrendArrow ?? 4),
        source: "freestyle_libre_3",
      }));

    const { error, count } = await supabase
      .from("glucose_readings")
      .upsert(rows, { onConflict: "timestamp,source", ignoreDuplicates: true })
      .select("id", { count: "exact", head: true });

    if (error) throw new Error(`Database fout: ${error.message}`);

    return new Response(
      JSON.stringify({
        success: true,
        message: `Synchronisatie voltooid. ${count ?? 0} nieuwe metingen opgeslagen (${rows.length} verwerkt).`,
        synced: count ?? 0,
        debug: debugInfo,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ success: false, message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
