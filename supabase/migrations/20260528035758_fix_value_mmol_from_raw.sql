/*
  # Fix value_mmol — was per ongeluk gedeeld door 18

  De LibreView API levert waarden al in mmol/L, maar de sync-code deelde ze
  nogmaals door 18.018. Hierdoor staan er waarden van ~0.3 in plaats van ~5-6.

  Deze migratie corrigeert alle bestaande rijen door value_mmol gelijk te stellen
  aan raw_value (afgerond op 2 decimalen).
*/
UPDATE glucose_readings
SET value_mmol = ROUND(raw_value::numeric, 2)
WHERE source = 'freestyle_libre_3';
