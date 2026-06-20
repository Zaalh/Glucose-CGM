# Plan: dynamische patroonherkenning (dip → harde stijging → harde daling)

## Aanleiding

Het terugkerende, atypische patroon: **kort na eten zakt de glucose even (dip), stijgt
daarna hard, en daalt vervolgens hard** richting (near-)hypo. Dit is geen "gemiddelde"
maaltijdrespons, maar wel een patroon dat vroeg gewaarschuwd moet worden.

De huidige live-overlay (`detectMealState` in `nightscout-overlay/rate-overlay.js`)
beslist op **vaste drempels** en herkent een gemiddelde maaltijd, niet specifiek deze vorm.

## Wat er al is (en niet opnieuw gebouwd hoeft)

- **Fase-keten** bestaat al: `dip → rising → plateau → reactive-drop`
  (`scripts/lib/meal-detector.mjs`). De vorm is dus gemodelleerd.
- **Vorm-/curve-similarity** bestaat al offline (`scripts/lib/episode-similarity.mjs`):
  - `findCurveMatches()` matcht de volledige genormaliseerde curve via cosine — dus een
    dip→stijging→daling-signatuur matcht op eerdere keren dat dezelfde vorm voorkwam.
  - `findSimilarEpisodes()` matcht op piek, val, tijd én aanloop (`riseRate15m`,
    `riseFromBaseline`).
  - Beide tellen hoeveel vergelijkbare episodes in (near-)hypo eindigden → gepersonaliseerd
    risico uit eigen historie.
- **Pattern wordt al berekend, opgeslagen én getoond**: `patternFromFeatures()` draait in
  `libreview-nightscout-sync.mjs:269`, `pattern` gaat mee in elke `prediction_snapshot`
  (`:361`), de overlay fetcht `/_prediction/latest` en *toont* het al
  (`dbPatternLineText`, `rate-overlay.js:4170`: "vergelijkbaar: beste N patronen · curve
  beste …"). Het voedt bovendien de V1-forecast-correctie (`rate-overlay.js:761`).
- `episode_vectors` bevat de volledige curve (`vector: shape`, `build-episode-vectors.mjs:152`)
  en `liveCurveShape` wordt gebouwd in `hypo-features.mjs:471` — curve-match is dus voedbaar.

> NB: de secties hieronder ("De echte gaten", "Risico's & ontwerpcorrecties", "Generalisatie")
> beschrijven het **verlaten vorm-similarity-pad** en zijn HISTORISCH. De actuele aanpak staat
> onder "HERZIENE AANPAK — feature-based postprandiale hypo-predictor".

## De echte gaten (na code-toetsing) — HISTORISCH (verlaten pad)

1. **HOOFDGAT — drop-context-gate blokkeert de vroege fase.**
   `patternFromFeatures()` geeft `null` tenzij
   `dropFromPeakMmol >= 2 && minutesSincePeak <= 60` (`episode-similarity.mjs:306`).
   Het patroonsignaal — inclusief de curve-match die de overlay al toont — vuurt dus pas
   als je al ~2 mmol gezakt bent. Voor het doel (vroeg waarschuwen bij dip→stijging) komt
   het signaal structureel te laat. Dit is het hart van het werk.
2. **`mealPatternFromState()` (de rise-onset variant) wordt nergens live aangeroepen.**
   Alleen in `run-meal-vector-check.mjs`. De rise-fase wordt niet tegen eigen episodes gematcht.
3. **De maaltijd-badge-risk (`scoreReactiveMealRisk`) gebruikt `pattern` niet.**
   Het pattern voedt wél de V1-forecast en de tekstregel, maar niet de badge-escalatie.

> Correctie t.o.v. eerste versie van dit plan: de overlay gebruikt het `pattern`-veld
> al (tonen + forecast-correctie). Het probleem is niet "niet bedraad" maar "te laat
> door de gate" + "badge-risk ongevoed".

## Meetresultaten Fase 0 (echte data, N=1) — GECORRIGEERD na senior/medische review

> Een eerste, niet-gecorrigeerde run leek signaal te tonen (separation +0.13). Na vijf
> methodologische fixes (episode-dedupe, klinische drempel <3.9 i.p.v. <4.5, outcome-lekkage
> verwijderd, gelijke populaties, artefact-gate) **valt dat signaal weg**. De eerste conclusie
> was een artefact van duplicaten + losse drempel + lekkage.

**Vorm draagt GEEN aantoonbaar signaal.** Schoon gemeten (`scripts/validate-dip-rise-drop.mjs`):
- Dedupe: 808 → **275** episodes (~65% waren bijna-duplicaten → leave-one-out lekte).
- Base-rate bij <3.9: **0.40** (was 0.90 met <4.5).
- **Vroege prefix (eerlijk, vóór de daling): separation 0.01, lift 1.05 → GEEN signaal bovenop
  base-rate.** De volledige-curve separation 0.10 telt niet (outcome-lekkage).
- Oorzaak: de curve-similarity normaliseert het **niveau** weg, terwijl absoluut niveau de
  sterkste hypo-voorspeller is. Vorm-alleen gooit de meest voorspellende info weg.

**Blinde-vlek-meting** (`scripts/measure-dip-rise-drop-blindspot.mjs`), na artefact-gate:
- **529 van 846 kandidaten waren artefacten** (1-sample dip / compressie-low). 318 echt, waarvan
  maar **75 echte hypo (<3.9)**.
- Selector-blinde vlek: 41% gemist (milde dalingen + traag/laat) — reëel maar kleiner corpus.
- Window: dip ligt mediaan **36 min** vóór de piek → [piek−20m] mist hem echt.

**Conclusie (gewijzigd): NIET op curve-vorm-similarity bouwen.** Er is geen aangetoond
vorm-signaal om te vangen. Vroege waarschuwing, indien nagestreefd, hoort op **niveau +
daalsnelheid + context (tijd-van-dag/maaltijd)** te steunen, niet op genormaliseerde vorm.
N=1, één methode — het bewijst niet dat het patroon zinloos is, wel dat deze aanpak niet werkt.

## Aanpak — validatie eerst, dan live bedraden

### Fase 0 — Valideren of de vorm-match dit patroon vangt (meten vóór bouwen)

Doel: bewijzen dat curve-/episode-similarity jouw dip→rise→drop-episodes daadwerkelijk
aan elkaar koppelt, vóór we iets live zetten.

- [x] Leave-one-out validatie `scripts/validate-dip-rise-drop.mjs` (+ npm-scripts). Base-rate-
      gecalibreerd + dedupe + klinische drempel. Uitkomst (schoon): **geen vorm-signaal** (prefix
      separation 0.01) — zie meetresultaten hierboven.
- [x] Blinde-vlek-meting `scripts/measure-dip-rise-drop-blindspot.mjs` (met artefact-gate). Uitkomst:
      318 echte kandidaten (529 artefact), 75 echte hypo; selector mist 41%; dip mediaan 36m vóór piek.
- **Beslispunt (gehaald):** vorm-similarity is GEEN bruikbaar signaal → verlaten. Overgestapt op de
      feature-based predictor (zie HERZIENE AANPAK).

## UPDATE 2026-06-20 — RIG getest en VERWORPEN; zie onderzoeksrapport

> A/B-test (`scripts/evaluate-rig-contribution.mjs`, grouped-CV per dag, klinisch <3.9 sustained):
> **niveau + daalsnelheid is het beste** (ROC-AUC ~0.74, PR-AUC ~0.42, lead ~10 min); de bestaande
> rise-features én RIG voegen niets toe (PR-AUC daalt zelfs licht). Positieve controle geslaagd
> → geen kapotte pijplijn. De milestones M1–M5 hieronder (die aannamen dat RIG hielp) zijn dus
> **niet uitgevoerd**: er is geen feature-winst te halen met CGM-alleen. Volledige uitwerking +
> cijfers in `reactieve-hypo-onderzoeksrapport.md`. Echte hefboom = externe context (maaltijd/
> activiteit), nu niet beschikbaar. M1–M5 blijven hieronder als historische context.

## HERZIENE AANPAK — feature-based postprandiale hypo-predictor (senior-dev + medisch uitgewerkt) — HISTORISCH

### Literatuur-onderbouwing

- **Seo et al. 2019** (BMC Med Inform, PMC6833234) — postprandiale hypo (<3.9, horizon 30m) uit CGM
  met 3 scalaire features: **huidig niveau**, **GRC** (rate of change), **RIG** = (piek − maaltijd) /
  tijd-tot-piek. RIG is de sleutelfeature (weglaten → instorten). Random Forest AUC 0.966.
- **Dave et al.** (PMC8258517) — feature-based real-time >91% sens/spec op 30/60m.
- **Meta-analyse 2025** (Springer s40200-025-01820-4) — CGM-ML hypo-predictie werkt (T1DM).

### Medische kanttekeningen (de literatuur is NIET 1:1 overdraagbaar)

1. **Gebruiker is niet-diabeet met reactieve/postprandiale hypoglykemie** — de meeste studies zijn
   T1DM. Maar de fysiologie hier (exagereerde insulinerespons op een snelle glucosestijging →
   overshoot-daling) maakt **RIG juist mechanistisch passend**: snelle stijging voorspelt de reactieve val.
2. **Klinische outcome-definitie aanscherpen.** Level-1 hypo = <3.9 mmol/L, Level-2 (klinisch
   significant) = <3.0. Gebruik een **sustained-event** (bijv. ≥15 min, ≥2 opeenvolgende metingen
   <3.9) i.p.v. één losse meting — sluit aan op ADA/internationaal consensus en weert sensorruis.
   De huidige `evaluate-predictions.mjs` labelt op losse `min30 < 4.0/4.5` → **aanpassen naar <3.9
   sustained**.
3. **CGM-beperkingen zijn label-ruis:** hogere MARD in de lage range, **sensorlag 5–15 min**,
   **compressie-lows** (vooral 's nachts). Pas de artefact-gate uit `measure-...-blindspot.mjs` ook
   op de labels toe; overweeg de horizon vanaf de fysiologische i.p.v. gemeten daling.
4. **Postprandiaal isoleren van nocturnaal** — andere fysiologie. Conditioneer op het maaltijd-anker
   (`detectMealState`) en/of tijd-van-dag; rapporteer apart.
5. **Alarmmoeheid is een klinische schade.** Een waarschuwing die te vaak vals vuurt wordt genegeerd
   (en dan mis je de echte). Kies een werkpunt met **hoge sensitiviteit binnen een vals-alarm-budget**,
   niet maximale sensitiviteit. En een **minimale lead-time (~≥10–15 min)** — eerder is niet
   actiehbaar (koolhydraten innemen kost tijd).

### Integratie met bestaande infra (NIET parallel bouwen)

De stack heeft dit grotendeels al:
- `scripts/lib/hypo-features.mjs` — featureset (currentMmol, blendedRate, rate5/10/15m, riseFromBaseline,
  riseRate15m, minutesSincePeak, maxFallRate…). **RIG hier toevoegen.**
- `scripts/lib/reactive-hypo-detector.mjs` — V2 component-score (currentScore, rateScore, reactiveScore,
  forecastScore, mealOnsetScore, patternScore…). **RIG wordt een nieuwe/uitgebreide component**, geen los model.
- `train-risk-model.mjs` → `model_state` → `risk-model-state.json` (thresholds/calibration/metrics) +
  `retrain-and-export-model.mjs` (TRAIN_POLICY balanced/precision). **Hergebruiken voor (her)training.**
- `evaluate-predictions.mjs` (30m-horizon outcome-labeling) + `prediction_snapshots.outcomeEvaluated`.
  **Hergebruiken voor shadow-evaluatie**; alleen de drempel/sustained-definitie aanscherpen.

### Statistische realiteitscheck (vóór modelleren)

Blindspot mat ~**75 echte hypo-events (<3.9)** in de hele historie (N=1). Dat is een **kleine positieve
klasse**. Gevolg: hou het model **klein** (logistische regressie of ondiepe RF, ~3–5 features, sterke
regularisatie); verwacht **brede betrouwbaarheidsintervallen**; rapporteer **PR-AUC** (niet alleen
ROC-AUC) wegens imbalance. Als de events na postprandiaal-gating < ~30–40 zijn, is een persoonlijk
model niet betrouwbaar → dan een **universele regel met RIG-drempel** i.p.v. een geleerd model.

### Milestones

**M1 — RIG-feature + pariteit.**
- [ ] `RIG = riseFromBaseline / minutesSincePeak` (guarded; null bij geen geldige piek) in
      `hypo-features.mjs`. Plus GRC = bestaande `rate5m/10m`.
- [ ] Train/serve-pariteit: identieke berekening offline (sync/backtest) en live; borg met een check
      (zie bestaande `meal:parity`-aanpak).

**M2 — Klinische labels + eerlijke evaluatie.**
- [ ] `evaluate-predictions.mjs`: target naar **<3.9 sustained (≥2 metingen / ≥15m)**, plus aparte
      <3.0-telling; artefact-gate op labels.
- [ ] `scripts/evaluate-postprandial-hypo.mjs`: walk-forward / **grouped CV per dag of per episode**
      (NOOIT willekeurige split — voorkomt de duplicaat-lekkage uit Fase 0). Conditioneer op
      maaltijd-venster (5m–3,5u na onset). Self-test + npm-script, conform conventie.

**M3 — Model trainen & vergelijken tegen baselines.**
- [ ] Train via bestaande pipeline; voeg RIG-component toe aan V2.
- [ ] **Baselines die verslagen moeten worden:** (a) huidige regel-detector V1/V2, (b) triviale
      "niveau + rate"-drempel. Geen claim zonder baseline.
- [ ] Metrics: PR-AUC, sensitiviteit @ vast vals-alarm-budget, **lead-time-verdeling**,
      kalibratie (Brier), met CI's.
- **Beslispunt:** alleen door als het de baselines verslaat op vals-alarm bij gelijke sensitiviteit
      én klinisch bruikbare lead-time.

**M4 — Shadow-mode (meten in productie, geen alarm).**
- [ ] Predictor-score meeschrijven in `prediction_snapshots` (zoals V2 shadow nu), `evaluate-predictions`
      vergelijkt met werkelijke uitkomst. ≥2–4 weken live observeren vóór het iets mag laten afgaan.

**M5 — Promotie achter omkeerbare flag.**
- [ ] RIG-component meelaten wegen in de alarm-score (niet als harde beslissing). Env-flag (zoals
      `REG_FEEDS_ALARMS`), `--force-recreate nightscout-ui`. Cold-start-terugval op de regel-detector.
- [ ] CHANGELOG + statusdocs (`hypo.md`/`predict.md`) bijwerken.

### Stop-condities / faalmodi

- Te weinig events na gating (<~30) → geen geleerd model; val terug op universele RIG-drempel.
- Geen winst op vals-alarm bij gelijke sensitiviteit t.o.v. baseline → niet promoten.
- Lead-time < ~10 min → niet actiehbaar, niet promoten.
- Kalibratie slecht / instabiel over CV-folds → model te complex voor de data, simplificeer.

### Verlaten pad (waarom)

Curve-vorm-similarity / het venster of de selector verbreden om de "dip" te leren is **verlaten**:
Fase 0 (schoon gemeten) toonde geen vorm-signaal, en de literatuur gebruikt niveau+rate+RIG, niet
vorm. Het venster verbreden lost een blinde vlek op zonder aantoonbaar signaal om te vangen.

## Risico's & ontwerpcorrecties (senior review — m.b.t. het verlaten vorm-pad, historisch)

1. **De gate bestaat niet voor niets — valse alarmen.** Het hele recente werk optimaliseerde
   op *minder valse alarmen* (zie `research-rate-estimator-pattern`). `dropFromPeakMmol >= 2`
   verlagen ruilt precies dat in. **Fase 0 moet de vals-alarm-kost meten, niet alleen recall.**
2. **In de vroege fase is er per definitie nog geen piek/drop.** Bij de dip/rise is
   `dropFromPeakMmol ≈ 0`, dus `findSimilarEpisodes()` (drop-centrisch) kán daar niets matchen.
   → **Ontwerpcorrectie:** het vroege signaal moet uit een **curve-prefix-match**
   (`findCurveMatches` op de partiële `liveCurveShape`) of rise-onset-features komen, los van
   de drop-gate. Fase 1 is dus niet "gate verlagen" maar "vroege fase via curve-prefix matchen".
3. **Steekproef-ondergrens.** `findCurveMatches`/`findSimilarEpisodes` vereisen ≥3 matches,
   anders `null`. Als de dip→rise→drop-vorm zeldzaam is in de historie, vuurt het signaal nooit,
   hoe goed de match ook is. Fase 0 moet eerst tellen hoeveel zulke episodes er überhaupt zijn.
4. **Curve-prefix-lengte.** `liveCurveShape` is partieel; cosine op een korte prefix is ruisig.
   Bewaak `CURVE_MIN_POINTS` (=8) — te vroeg matchen op 2-3 punten is onbetrouwbaar.

## Generalisatie (werkt voor mij én anderen — profielneutraal)

Eis: geen enkel persoonlijk patroon hard-coderen (zie `feedback-profile-neutral-ai`).
De aanpak voldoet hieraan omdat hij intrinsiek per-persoon leert, mits:

- **Per-persoon matching:** similarity vergelijkt altijd tegen de *eigen* `episode_vectors`.
- **Schaal-/niveau-invariant:** zero-mean unit-norm + vorm-detectie in amplitude-fracties.
- **Universele, herijkbare drempels:** `DIP_FRACTION` / `RISE_FRACTION` / `HYPO_RATIO_GATE`
  zijn universele vorm-heuristieken (env-overschrijfbaar, tuner-baar), geen persoonlijke tuning.
- **Universele klinische ankers** (3.9/4.5/3.0) blijven gescheiden en configureerbaar.
- **Cold-start-terugval:** onder `MIN_RELIABLE_EPISODES` eigen episodes vertrouwt de live-flow
  het persoonlijke patroon NIET en valt terug op de universele regel-detector. De ladder is:
  nieuwe gebruiker → regel-detector → vorm-match neemt over zodra er genoeg eigen data is.

## Niet-doelen

- Geen closed-loop/insuline-tooling (gebruiker = reactieve hypo, geen diabetes).
- Geen zwaar deep-learning-model: klein en uitlegbaar (logistisch/RF op ~3–5 features),
  bij voorkeur als extra V2-component i.p.v. een los model.
- V2-detector / §21 ongemoeid tenzij expliciet.
