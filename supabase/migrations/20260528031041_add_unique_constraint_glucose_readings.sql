/*
  # Unieke constraint voor glucose_readings

  Voegt een unieke constraint toe op (timestamp, source) zodat de LibreView
  sync upsert kan gebruiken zonder duplicaten in te voegen.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'glucose_readings_timestamp_source_unique'
  ) THEN
    ALTER TABLE glucose_readings
      ADD CONSTRAINT glucose_readings_timestamp_source_unique
      UNIQUE (timestamp, source);
  END IF;
END $$;
