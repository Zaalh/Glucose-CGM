import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const LIBRE_EMAIL = Deno.env.get("LIBREVIEW_EMAIL") ?? "Storagegox654@gmail.com";
const LIBRE_PASSWORD = Deno.env.get("LIBREVIEW_PASSWORD") ?? "Jezismina11!";
// EU regio endpoint (Nederland)
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

async function libreLogin(): Promise<{ token: string; baseUrl: string }> {
  const res = await fetch(`${LIBRE_API}/llu/auth/login`, {
    method: "POST",
    headers: LIBRE_HEADERS,
    body: JSON.stringify({ email: LIBRE_EMAIL, password: LIBRE_PASSWORD }),
  });
  if (!res.ok) throw new Error(`LibreView login mislukt: ${res.status}`);
  const json = await res.json();

  // Abbott stuurt soms een redirect naar een andere regio
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
    return { token: json2.data.authTicket.token, baseUrl: regionalApi };
  }

  return { token: json.data.authTicket.token, baseUrl: LIBRE_API };
}

async function fetchConnections(token: string, baseUrl: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/llu/connections`, {
    headers: { ...LIBRE_HEADERS, "Authorization": `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Verbindingen ophalen mislukt: ${res.status}`);
  const json = await res.json();
  return (json.data ?? []).map((c: { patientId: string }) => c.patientId);
}

async function fetchGraph(token: string, baseUrl: string, patientId: string) {
  const res = await fetch(`${baseUrl}/llu/connections/${patientId}/graph`, {
    headers: { ...LIBRE_HEADERS, "Authorization": `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Graph ophalen mislukt: ${res.status}`);
  const json = await res.json();
  return json.data;
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

    // Login bij LibreView (EU regio)
    const { token, baseUrl } = await libreLogin();

    // Haal verbonden patienten/sensoren op
    const connections = await fetchConnections(token, baseUrl);
    if (connections.length === 0) {
      return new Response(
        JSON.stringify({ success: false, message: "Geen verbonden sensoren gevonden. Controleer LibreLink Up instellingen." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let totalInserted = 0;

    for (const patientId of connections) {
      const graph = await fetchGraph(token, baseUrl, patientId);

      // graphData bevat historische metingen
      const graphData: Array<{
        Timestamp: string;
        Value: number;
        TrendArrow: number;
      }> = graph?.graphData ?? [];

      // currentMeasurement toevoegen indien aanwezig
      if (graph?.connection?.glucoseMeasurement) {
        const cur = graph.connection.glucoseMeasurement;
        graphData.push({
          Timestamp: cur.Timestamp,
          Value: cur.Value,
          TrendArrow: cur.TrendArrow,
        });
      }

      if (graphData.length === 0) continue;

      const rows = graphData.map((pt) => ({
        timestamp: new Date(pt.Timestamp.replace(" ", "T")).toISOString(),
        value_mmol: parseFloat((pt.Value / 18.018).toFixed(2)),
        raw_value: pt.Value,
        unit: "mg/dL",
        trend: mapTrend(pt.TrendArrow),
        source: "freestyle_libre_3",
      }));

      // Upsert op basis van timestamp + source om duplicaten te voorkomen
      const { error, count } = await supabase
        .from("glucose_readings")
        .upsert(rows, { onConflict: "timestamp,source", ignoreDuplicates: true })
        .select("id", { count: "exact", head: true });

      if (error) throw new Error(`Database fout: ${error.message}`);
      totalInserted += count ?? 0;
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Synchronisatie voltooid. ${totalInserted} nieuwe metingen opgeslagen.`,
        synced: totalInserted,
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
