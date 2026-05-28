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

function lluHeaders(token: string, accountId: string) {
  return { ...LLU_HEADERS, "Authorization": `Bearer ${token}`, "account-id": accountId };
}

async function apiGet(token: string, accountId: string, baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: lluHeaders(token, accountId) });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, ok: res.ok, json };
}

async function collectReadings(token: string, accountId: string, baseUrl: string, userId: string): Promise<RawReading[]> {
  // Stap 1: LibreLinkUp verbindingen (follower/caregiver account)
  const connRes = await apiGet(token, accountId, baseUrl, "/llu/connections");
  if (connRes.ok) {
    const connections = ((connRes.json as Record<string, unknown>).data as Array<{ patientId: string }>) ?? [];
    const readings: RawReading[] = [];
    for (const conn of connections) {
      const graphRes = await apiGet(token, accountId, baseUrl, `/llu/connections/${conn.patientId}/graph`);
      if (!graphRes.ok) continue;
      const graph = (graphRes.json as Record<string, unknown>).data as Record<string, unknown>;
      const pts: RawReading[] = (graph?.graphData as RawReading[]) ?? [];
      const cur = (graph?.connection as Record<string, unknown>)?.glucoseMeasurement as RawReading | undefined;
      if (cur) pts.push(cur);
      readings.push(...pts);
    }
    if (readings.length > 0) return readings;
  }

  // Stap 2: eigen sensordata via lsl/api (patient account)
  const lslRes = await apiGet(token, accountId, baseUrl,
    `/lsl/api/measurements/GetPatientGlucoseMeasurements?country=NL&patientId=${userId}`
  );
  if (lslRes.ok && lslRes.json) {
    const data = (lslRes.json as Record<string, unknown>).data;
    const pts = Array.isArray(data) ? data as RawReading[] : [];
    if (pts.length > 0) return pts;
  }

  // Stap 3: glucoseHistory met juiste parameters
  const histRes = await apiGet(token, accountId, baseUrl, "/glucoseHistory?numPeriods=5&period=7");
  if (histRes.ok) {
    const periods = ((histRes.json as Record<string, unknown>).data as Record<string, unknown>)
      ?.periods as Array<{ data?: RawReading[] }> ?? [];
    const readings = periods.flatMap((p) => p.data ?? []);
    if (readings.length > 0) return readings;
  }

  throw new Error(
    `Geen sensordata gevonden. API responses: connections=${connRes.status}, lsl=${lslRes.status}, history=${histRes.status}. ` +
    `Controleer of de sensor actief is in de FreeStyle LibreLink app. ` +
    `Als je geen LibreLink Up follower hebt: open de LibreLink app, ga naar Verbindingen en voeg een follower toe (kan je eigen tweede account zijn).`
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
    const graphData = await collectReadings(token, accountId, baseUrl, userId);

    const rows = graphData.map((pt) => ({
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
