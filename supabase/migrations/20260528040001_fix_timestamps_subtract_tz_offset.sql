/*
  # Fix timestamps — lokale tijd (UTC+2) opgeslagen als UTC

  LibreView geeft lokale tijden terug zonder timezone. Ze werden opgeslagen
  alsof ze UTC waren, maar zijn eigenlijk Amsterdam-tijd (UTC+2 zomertijd).
  Trek 2 uur af van alle bestaande metingen om echte UTC te krijgen.
*/
UPDATE glucose_readings
SET timestamp = timestamp - INTERVAL '2 hours'
WHERE source = 'freestyle_libre_3';
