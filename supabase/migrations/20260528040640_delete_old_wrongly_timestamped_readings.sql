/*
  # Verwijder foutief getimestampte metingen

  De originele 126 metingen hadden geen raw_timestamp kolom en werden meerdere
  keren met een verkeerde timezone-offset opgeslagen. De nieuwe sync slaat
  correct getimestampte metingen op (raw_timestamp IS NOT NULL).
  Verwijder de oude verkeerde data zodat de sync opnieuw kan beginnen.
*/
DELETE FROM glucose_readings WHERE raw_timestamp IS NULL;
