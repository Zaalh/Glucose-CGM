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

type RawReading = { Timestamp: string; Value: number; TrendArrow: number };

function mapTrend(trend: number): string {
  const map: Record<number, string> = {
    1: "falling_quickly", 2: "falling", 3: "falling_slowly",
    4: "flat", 5: "rising_slowly", 6: "rising", 7: "rising_quickly",
  };
  return map[trend] ?? "flat";
}

async function libreLogin(): Promise<{ token: string; baseUrl: string }> {
  const res = await fetch(`${LIBRE_API}/llu/auth/login`, {
    method: "POST",
    headers: LIBRE_HEADERS,
    body: JSON.stringify({ email: LIBRE_EMAIL, password: LIBRE_PASSWORD }),
  });

  const text = await res.text();
  let json: Record<string, unknown>;
  try { json = JSON.parse(text); } catch { throw new Error(`Login parse fout: ${text.slice(0, 200)}`); }

  if (!res.ok) throw new Error(`Login mislukt (${res.status}): ${JSON.stringify(json)}`);

  // Abbott stuurt redirect naar regionale server
  if ((json.data as Record<string, unknown>)?.redirect) {
    const region = (json.data as Record<string, unknown>).region as string;
    const regionalApi = `https://api-${region}.libreview.io`;
    const res2 = await fetch(`${regionalApi}/llu/auth/login`, {
      method: "POST",
      headers: LIBRE_HEADERS,
      body: JSON.stringify({ email: LIBRE_EMAIL, password: LIBRE_PASSWORD }),
    });
    const json2 = await res2.json();
    if (!res2.ok) throw new Error(`Regionale login mislukt (${res2.status})`);
    return {
      token: (json2.data as Record<string, unknown>).authTicket?.token as string,
      baseUrl: regionalApi,
    };
  }

  return {
    token: ((json.data as Record<string, unknown>).authTicket as Record<string, unknown>)?.token as string,
    baseUrl: LIBRE_API,
  };
}

async function apiGet(token: string, baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { ...LIBRE_HEADERS, "Authorization": `Bearer ${token}` },
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new Error(`Parse fout ${path}: ${text.slice(0, 200)}`); }
  return { status: res.status, ok: res.ok, json };
}

async function collectReadings(token: string, baseUrl: string): Promise<RawReading[]> {
  // Stap 1: probeer LibreLink Up verbindingen (voor followers/caregivers)
  const connRes = await apiGet(token, baseUrl, "/llu/connections");

  if (connRes.ok) {
    const connections = ((connRes.json as Record<string, unknown>).data as Array<{ patientId: string }>) ?? [];
    const readings: RawReading[] = [];
    for (const conn of connections) {
      const graphRes = await apiGet(token, baseUrl, `/llu/connections/${conn.patientId}/graph`);
      if (!graphRes.ok) continue;
      const graph = (graphRes.json as Record<string, unknown>).data as Record<string, unknown>;
      const pts: RawReading[] = (graph?.graphData as RawReading[]) ?? [];
      const cur = (graph?.connection as Record<string, unknown>)?.glucoseMeasurement as RawReading | undefined;
      if (cur) pts.push(cur);
      readings.push(...pts);
    }
    if (readings.length > 0) return readings;
  }

  // Stap 2: probeer /llu/data (eigen sensor, nieuwere API versie)
  const dataRes = await apiGet(token, baseUrl, "/llu/data");
  if (dataRes.ok) {
    const d = (dataRes.json as Record<string, unknown>).data as Record<string, unknown> | null;
    const pts: RawReading[] = (d?.graphData as RawReading[]) ?? [];
    const cur = d?.currentMeasurement as RawReading | undefined;
    if (cur) pts.push(cur);
    if (pts.length > 0) return pts;
  }

  // Stap 3: probeer /glucoseHistory
  const histRes = await apiGet(token, baseUrl, "/glucoseHistory?numPeriods=1&period=13");
  if (histRes.ok) {
    const periods = ((histRes.json as Record<string, unknown>).data as Record<string, unknown>)
      ?.periods as Array<{ data?: RawReading[] }> ?? [];
    const readings = periods.flatMap((p) => p.data ?? []);
    if (readings.length > 0) return readings;
  }

  // Geef nuttige foutmelding met HTTP statussen voor diagnose
  throw new Error(
    `Geen sensordata gevonden. API responses: connections=${connRes.status}, data=${dataRes.status}, history=${histRes.status}. ` +
    `Zorg dat je sensor gekoppeld is in de FreeStyle LibreLink app en dat LibreLink Up is ingeschakeld.`
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

    const { token, baseUrl } = await libreLogin();
    const graphData = await collectReadings(token, baseUrl);

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
