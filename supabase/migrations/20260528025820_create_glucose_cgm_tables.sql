/*
  # Glucose CGM - Basistabellen

  1. Nieuwe tabellen
    - `glucose_readings`: slaat elke glucosemeting op
      - id (uuid, pk)
      - timestamp: meetmoment van de sensor
      - value_mmol: waarde in mmol/L
      - trend: richtingsindicator (bijv. 'flat', 'rising')
      - source: sensorbron (bijv. 'nightscout', 'dexcom')
      - raw_value: originele waarde vóór conversie
      - unit: eenheid van raw_value ('mg/dL' of 'mmol/L')
      - created_at: tijdstip van invoer in de database

    - `alert_rules`: drempelwaarde-regels voor alarmen
      - id (uuid, pk)
      - name: naam van de regel
      - threshold_low: ondergrens in mmol/L
      - threshold_high: bovengrens in mmol/L
      - enabled: regel actief of niet
      - created_at

  2. Beveiliging
    - RLS ingeschakeld op beide tabellen
    - Policies: alle geauthenticeerde gebruikers kunnen lezen/schrijven
      (voor een single-user CGM setup)
*/

CREATE TABLE IF NOT EXISTS glucose_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp timestamptz NOT NULL,
  value_mmol numeric(5,2) NOT NULL,
  trend text,
  source text NOT NULL DEFAULT 'manual',
  raw_value numeric(7,2),
  unit text NOT NULL DEFAULT 'mmol/L',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS glucose_readings_timestamp_idx ON glucose_readings (timestamp DESC);

ALTER TABLE glucose_readings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read glucose readings"
  ON glucose_readings FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert glucose readings"
  ON glucose_readings FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update glucose readings"
  ON glucose_readings FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete glucose readings"
  ON glucose_readings FOR DELETE
  TO authenticated
  USING (true);

CREATE TABLE IF NOT EXISTS alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT '',
  threshold_low numeric(5,2),
  threshold_high numeric(5,2),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE alert_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read alert rules"
  ON alert_rules FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert alert rules"
  ON alert_rules FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update alert rules"
  ON alert_rules FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete alert rules"
  ON alert_rules FOR DELETE
  TO authenticated
  USING (true);
