# Glucose CGM Plan

## Doel
Een sensor-agnostische CGM-basis opzetten voor het inlezen, opslaan en eventueel alarmeren van glucosewaarden.

## Huidige basis
- `GlucoseReading` model bestaat al in `src/glucose_cgm/models.py`
- `SensorAdapter` interface bestaat al in `src/glucose_cgm/adapters/base.py`
- Project gebruikt een `src/`-structuur met `pyproject.toml`

## Plan van aanpak
1. **Adapter-laag uitbreiden**
   - Implementeren van concrete adapters per sensorbron
   - Standaardiseren van output naar `GlucoseReading`

2. **Inname en normalisatie**
   - Binnenkomende data valideren
   - Eenheden en trends normaliseren
   - Foutstatussen consequent afhandelen

3. **Opslaglaag toevoegen**
   - Metingen bewaren in een lokale of externe datastore
   - Historie en laatste waarde beschikbaar maken

4. **Alerting / regels**
   - Drempelwaarden instellen
   - Waarschuwingen genereren bij lage of hoge waarden

5. **Testen en kwaliteit**
   - Unit tests voor modellen en adapters
   - Basisvalidatie op type- en dataconversies

## Eerste oplevering
- Werkende adapter-structuur
- Eerste end-to-end flow van bron naar `GlucoseReading`
- Basisdocumentatie in de repo

## Volgende stap
- Concrete sensorbron kiezen en de eerste adapter implementeren
