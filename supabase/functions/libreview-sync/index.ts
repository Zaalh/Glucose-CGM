import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const LIBRE_EMAIL = Deno.env.get("LIBREVIEW_EMAIL") ?? "Storagegox654@gmail.com";
const LIBRE_PASSWORD = Deno.env.get("LIBREVIEW_PASSWORD") ?? "Jezismina11!";
const LIBRE_API = "https://api-eu.libreview.io";

const LIBRE_HEADERS = {
  "Content-Type": "application/json",
  "product": "llu.android",
  "version": "4.7.0",
  "Accept-Encoding": "gzip",
  "cache-control": "no-cache",
  "connection": "Keep-Alive",
};

function mapTrend(trend: number): string {
  switch (trend) {
    case 1: return "falling_quickly";
    case 2: return "falling";
    case 3: return "falling_slowly";
    case 4: return "flat";
    case 5: return "rising_slowly";
    case 6: return "rising";
    case 7: return "rising_quickly";
    default: return "flat";
  }
}

interface LoginResult {
  token: string;
  baseUrl: string;
  accountId: string;
}

async function libreLogin(): Promise<LoginResult> {
  const res = await fetch(`${LIBRE_API}/llu/auth/login`, {
    method: "POST",
    headers: LIBRE_HEADERS,
    body: JSON.stringify({ email: LIBRE_EMAIL, password: LIBRE_PASSWORD }),
  });
  if (!res.ok) throw new Error(`LibreView login mislukt: ${res.status}`);
  const json = await res.json();

  if (json.data?.redirect) {
    const region = json.data.region;
    const regionalApi = `https://api-${region}.libreview.io`;
    const res2 = await fetch(`${regionalApi}/llu/auth/login`, {
      method: "POST",
      headers: LIBRE_HEADERS,
      body: JSON.stringify({ email: LIBRE_EMAIL, password: LIBRE_PASSWORD }),
    });
    if (!res2.ok) throw new Error(`LibreView regionale login mislukt: ${res2.status}`);
    const json2 = await res2.json();
    return {
      token: json2.data.authTicket.token,
      baseUrl: regionalApi,
      accountId: json2.data.user.id,
    };
  }

  return {
    token: json.data.authTicket.token,
    baseUrl: LIBRE_API,
    accountId: json.data.user.id,
  };
}

// Probeer eerst /llu/connections (LibreLink Up followers)
// Als 403, val terug op /glucoseHistory voor eigen sensor
async function fetchReadingsFromConnections(
  token: string,
  baseUrl: string,
): Promise<Array<{ Timestamp: string; Value: number; TrendArrow: number }>> {
  const res = await fetch(`${baseUrl}/llu/connections`, {
    headers: { ...LIBRE_HEADERS, "Authorization": `Bearer ${token}` },
  });

  // 403 = account heeft geen LibreLink Up, gebruik eigen sensordata
  if (res.status === 403) {
    return [];
  }
  if (!res.ok) throw new Error(`Verbindingen ophalen mislukt: ${res.status}`);

  const json = await res.json();
  const connections: Array<{ patientId: string }> = json.data ?? [];
  const readings: Array<{ Timestamp: string; Value: number; TrendArrow: number }> = [];

  for (const conn of connections) {
    const graphRes = await fetch(`${baseUrl}/llu/connections/${conn.patientId}/graph`, {
      headers: { ...LIBRE_HEADERS, "Authorization": `Bearer ${token}` },
    });
    if (!graphRes.ok) continue;
    const graphJson = await graphRes.json();
    const graph = graphJson.data;

    const pts: Array<{ Timestamp: string; Value: number; TrendArrow: number }> =
      graph?.graphData ?? [];
    if (graph?.connection?.glucoseMeasurement) {
      pts.push(graph.connection.glucoseMeasurement);
    }
    readings.push(...pts);
  }

  return readings;
}

// Haal de eigen sensordata op via /glucoseHistory (geen LibreLink Up nodig)
async function fetchOwnSensorData(
  token: string,
  baseUrl: string,
): Promise<Array<{ Timestamp: string; Value: number; TrendArrow: number }>> {
  // Probeer /llu/glucoseHistory (nieuwere API)
  const res = await fetch(`${baseUrl}/glucoseHistory?numPeriods=1&period=13`, {
    headers: { ...LIBRE_HEADERS, "Authorization": `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(
      `Sensordata ophalen mislukt (${res.status}). Zorg dat LibreLink Up actief is in de FreeStyle LibreLink app, of koppel je sensor via LibreLink Up.`
    );
  }

  const json = await res.json();

  // glucoseHistory geeft data per periode terug
  const periods: Array<{
    data?: Array<{ Timestamp: string; Value: number; TrendArrow: number }>;
  }> = json.data?.periods ?? [];

  return periods.flatMap((p) => p.data ?? []);
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

    const { token, baseUrl } = await libreLogin();

    // Probeer verbindingen (LibreLink Up), anders eigen sensor
    let graphData = await fetchReadingsFromConnections(token, baseUrl);
    if (graphData.length === 0) {
      graphData = await fetchOwnSensorData(token, baseUrl);
    }

    if (graphData.length === 0) {
      return new Response(
        JSON.stringify({ success: false, message: "Geen metingen gevonden." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

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
        message: `Synchronisatie voltooid. ${count ?? 0} nieuwe metingen opgeslagen.`,
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
