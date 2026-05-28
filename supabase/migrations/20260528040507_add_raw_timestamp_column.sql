/*
  # Voeg raw_timestamp kolom toe voor debugging

  Slaat de originele timestamp string op zoals die van de LibreView API komt,
  zodat we exact kunnen zien welk formaat/tijdzone de API gebruikt.
*/
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'glucose_readings' AND column_name = 'raw_timestamp'
  ) THEN
    ALTER TABLE glucose_readings ADD COLUMN raw_timestamp text;
  END IF;
END $$;
