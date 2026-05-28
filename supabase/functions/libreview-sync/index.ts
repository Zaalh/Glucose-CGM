import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { crypto } from "jsr:@std/crypto@0.224.0";
import { encodeHex } from "jsr:@std/encoding@0.224.0/hex";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const LIBRE_API = "https://api-eu.libreview.io";

async function getCredentials(supabase: ReturnType<typeof createClient>): Promise<{ email: string; password: string; tzOffsetMinutes: number }> {
  const { data } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", ["libreview_email", "libreview_password", "libreview_tz_offset"]);

  const map = Object.fromEntries((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
  const email = map.libreview_email || Deno.env.get("LIBREVIEW_EMAIL") || "";
  const password = map.libreview_password || Deno.env.get("LIBREVIEW_PASSWORD") || "";
  // Offset in minuten tov UTC, bijv. 120 voor UTC+2 (Amsterdam zomertijd)
  const tzOffsetMinutes = map.libreview_tz_offset != null ? parseInt(map.libreview_tz_offset) : 120;

  if (!email || !password) throw new Error("Geen LibreView credentials. Ga naar Instellingen om ze in te voeren.");
  return { email, password, tzOffsetMinutes };
}

// Headers voor de LLU API (/llu/...)
const LLU_BASE_HEADERS = {
  "Content-Type": "application/json",
  "product": "llu.android",
  "version": "4.16.0",
  "Accept-Encoding": "gzip",
  "cache-control": "no-cache",
  "connection": "Keep-Alive",
};

// Headers voor de LSL API (/lsl/api/...) — vereist Domain + GatewayType
const LSL_BASE_HEADERS = {
  "Content-Type": "application/json",
  "Domain": "Libreview",
  "GatewayType": "LinkUp.Android",
  "Accept-Encoding": "gzip",
  "cache-control": "no-cache",
  "connection": "Keep-Alive",
};

type RawReading = { Timestamp: string; Value: number; TrendArrow: number };

function parseLibreTimestamp(ts: string, tzOffsetMinutes: number): string {
  if (!ts) throw new Error(`Lege timestamp`);

  // Unix epoch getal — altijd al UTC
  const asNum = Number(ts);
  if (!isNaN(asNum) && asNum > 1_000_000_000) {
    return new Date(asNum * (asNum < 1e12 ? 1000 : 1)).toISOString();
  }

  // Heeft al een timezone aanduiding (Z / +HH:MM) — gebruik direct
  if (/[Zz]$/.test(ts) || /[+-]\d{2}:\d{2}$/.test(ts)) {
    const d = new Date(ts.replace(" ", "T"));
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  // Lokale tijd zonder timezone — parseer als lokale string en trek offset af
  let localMs: number | null = null;

  // ISO/spatie: "2025-01-12 14:35:00" of "2025-01-12T14:35:00"
  const isoNorm = ts.replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(isoNorm)) {
    const d = new Date(isoNorm);
    if (!isNaN(d.getTime())) localMs = d.getTime();
  }

  // US: "1/12/2025 14:35:00"
  if (localMs === null) {
    const m = ts.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
    if (m) {
      const d = new Date(`${m[3]}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}T${m[4].padStart(2,"0")}:${m[5]}:${m[6]}`);
      if (!isNaN(d.getTime())) localMs = d.getTime();
    }
  }

  // EU: "12-01-2025 14:35:00"
  if (localMs === null) {
    const m = ts.match(/^(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
    if (m) {
      const d = new Date(`${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}T${m[4].padStart(2,"0")}:${m[5]}:${m[6]}`);
      if (!isNaN(d.getTime())) localMs = d.getTime();
    }
  }

  if (localMs === null) throw new Error(`Onbekend timestamp formaat: ${ts}`);

  // Trek de lokale UTC-offset af zodat we echte UTC krijgen
  return new Date(localMs - tzOffsetMinutes * 60_000).toISOString();
}

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
  lluToken: string;
  lslToken: string;
  baseUrl: string;
  accountId: string;
  userId: string;
}

async function libreLogin(email: string, password: string): Promise<LoginResult> {
  const doLluLogin = async (baseUrl: string) => {
    const res = await fetch(`${baseUrl}/llu/auth/login`, {
      method: "POST",
      headers: LLU_BASE_HEADERS,
      body: JSON.stringify({ email, password }),
    });
    const text = await res.text();
    let json: Record<string, unknown>;
    try { json = JSON.parse(text); } catch { throw new Error(`Login parse fout: ${text.slice(0, 200)}`); }
    if (!res.ok) throw new Error(`Login mislukt (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  };

  let json = await doLluLogin(LIBRE_API);
  let baseUrl = LIBRE_API;

  // Volg regionale redirect indien nodig
  if ((json.data as Record<string, unknown>)?.redirect) {
    const region = (json.data as Record<string, unknown>).region as string;
    baseUrl = `https://api-${region}.libreview.io`;
    json = await doLluLogin(baseUrl);
  }

  const data = json.data as Record<string, unknown>;
  const userId = (data.user as Record<string, unknown>).id as string;
  const lluToken = (data.authTicket as Record<string, unknown>).token as string;
  const accountId = await sha256hex(userId);

  // LSL login gebruikt andere endpoint en headers
  const lslRes = await fetch(`${baseUrl}/lsl/api/nisperson/getauthenticateduser`, {
    method: "POST",
    headers: { ...LSL_BASE_HEADERS, "Authorization": `Bearer ${lluToken}` },
    body: JSON.stringify({ email, password }),
  });
  const lslText = await lslRes.text();
  let lslJson: Record<string, unknown> = {};
  try { lslJson = JSON.parse(lslText); } catch { /* gebruik lluToken als fallback */ }

  // Extraheer lsl token of gebruik hetzelfde token als fallback
  const lslToken = (lslJson.data as Record<string, unknown>)?.authToken as string ?? lluToken;

  return { lluToken, lslToken, baseUrl, accountId, userId };
}

async function lluGet(token: string, accountId: string, baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { ...LLU_BASE_HEADERS, "Authorization": `Bearer ${token}`, "account-id": accountId },
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, ok: res.ok, json };
}

async function lslGet(token: string, baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { ...LSL_BASE_HEADERS, "Authorization": `Bearer ${token}` },
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, ok: res.ok, json };
}

// Probeer alle bekende response-structuren te parseren
function extractReadings(json: unknown): RawReading[] {
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  const data = obj.data;

  if (Array.isArray(data)) return data as RawReading[];

  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;

    // { data: { graphData: [...], connection: { glucoseMeasurement: {...} } } }
    if (Array.isArray(d.graphData)) {
      const pts = [...(d.graphData as RawReading[])];
      const cur = (d.connection as Record<string, unknown>)?.glucoseMeasurement as RawReading | undefined;
      if (cur?.Timestamp) pts.push(cur);
      return pts;
    }

    // { data: { periods: [{ data: [...] }] } }
    if (Array.isArray(d.periods)) {
      return (d.periods as Array<{ data?: RawReading[] }>).flatMap(p => p.data ?? []);
    }

    // { data: { results: [...] } }
    if (Array.isArray(d.results)) return d.results as RawReading[];

    // { data: { data: [...] } }
    if (Array.isArray(d.data)) return d.data as RawReading[];
  }

  if (Array.isArray(json)) return json as RawReading[];
  return [];
}

async function collectReadings(
  lluToken: string, lslToken: string, accountId: string, baseUrl: string, userId: string
): Promise<{ readings: RawReading[]; debugInfo: string }> {
  const debug: string[] = [];

  // Poging 1: LLU connections (follower-flow)
  const connRes = await lluGet(lluToken, accountId, baseUrl, "/llu/connections");
  debug.push(`llu_conn=${connRes.status}`);

  if (connRes.ok) {
    const connections = ((connRes.json as Record<string, unknown>).data as Array<{ patientId: string }>) ?? [];
    const readings: RawReading[] = [];
    for (const conn of connections) {
      const graphRes = await lluGet(lluToken, accountId, baseUrl, `/llu/connections/${conn.patientId}/graph`);
      if (!graphRes.ok) continue;
      const pts = extractReadings(graphRes.json);
      readings.push(...pts);
    }
    if (readings.length > 0) return { readings, debugInfo: debug.join(", ") };
  }

  // Poging 2: LSL glucose history (eigen sensor, correcte headers)
  const histRes = await lslGet(lslToken, baseUrl, "/glucoseHistory?numPeriods=5&period=7");
  debug.push(`lsl_hist=${histRes.status}`);
  if (histRes.ok) {
    const readings = extractReadings(histRes.json);
    if (readings.length > 0) {
      debug.push(`found=${readings.length}`);
      return { readings, debugInfo: debug.join(", ") };
    }
    debug.push(`hist_body=${JSON.stringify(histRes.json).slice(0, 100)}`);
  }

  // Poging 3: LSL getPatientGlucoseMeasurements
  const measRes = await lslGet(lslToken, baseUrl, `/lsl/api/measurements/GetPatientGlucoseMeasurements?patientId=${userId}`);
  debug.push(`lsl_meas=${measRes.status}`);
  if (measRes.ok) {
    const readings = extractReadings(measRes.json);
    if (readings.length > 0) {
      debug.push(`found=${readings.length}`);
      return { readings, debugInfo: debug.join(", ") };
    }
    debug.push(`meas_body=${JSON.stringify(measRes.json).slice(0, 120)}`);
  }

  // Poging 4: LLU graph voor eigen account
  const selfGraphRes = await lluGet(lluToken, accountId, baseUrl, `/llu/users/${userId}/graph`);
  debug.push(`llu_self=${selfGraphRes.status}`);
  if (selfGraphRes.ok) {
    const readings = extractReadings(selfGraphRes.json);
    if (readings.length > 0) return { readings, debugInfo: debug.join(", ") };
  }

  throw new Error(
    `Geen sensordata. Debug: ${debug.join(", ")}. ` +
    `De /llu/connections geeft 403 — open de FreeStyle LibreLink app en accepteer de gebruiksvoorwaarden. ` +
    `Dit lost de 403 op zodat de sync kan werken.`
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

    const { email, password, tzOffsetMinutes } = await getCredentials(supabase);
    const { lluToken, lslToken, baseUrl, accountId, userId } = await libreLogin(email, password);
    const { readings: graphData, debugInfo } = await collectReadings(
      lluToken, lslToken, accountId, baseUrl, userId
    );

    const sampleRaw = graphData.slice(0, 2).map(pt => ({ raw_ts: pt.Timestamp, value: pt.Value }));
    const rows = graphData
      .filter(pt => pt.Timestamp && pt.Value)
      .map((pt) => ({
        timestamp: parseLibreTimestamp(pt.Timestamp, tzOffsetMinutes),
        value_mmol: parseFloat(pt.Value.toFixed(2)),
        raw_value: pt.Value,
        unit: "mg/dL",
        trend: mapTrend(pt.TrendArrow ?? 4),
        source: "freestyle_libre_3",
      }));

    const sampleParsed = rows.slice(0, 2).map(r => r.timestamp);

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
        debug: { ...debugInfo, sampleRaw, sampleParsed, tzOffsetMinutes, denoNow: new Date().toISOString() },
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
