/*
  # Sta anonieme leestoegang toe voor glucose_readings

  De app heeft geen gebruikersauthenticatie. De glucosedata wordt alleen
  door de edge function ingeschreven (met service role key) en gelezen
  door de frontend (met anon key). Voeg een SELECT policy toe voor anon.
*/
CREATE POLICY "Anon users can read glucose readings"
  ON glucose_readings
  FOR SELECT
  TO anon
  USING (true);
