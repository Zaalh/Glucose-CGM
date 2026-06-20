# Plan: alarm-kwaliteit — event-niveau evaluatie + klinisch label + vals-alarm-budget

## Aanleiding

Uit het onderzoek (`reactieve-hypo-onderzoeksrapport.md`): de winst zit niet in nieuwe CGM-features
(vorm, RIG, variabiliteit/tijd — alle getest, geen operationele winst), maar in **betere
alarm-kwaliteit met wat er al is**. Drie concrete bevindingen:

1. **Alarmmoeheid.** Op punt-niveau vuurt zelfs V2 ~37% van de tijd; precisie ~0.30 → ~70% van de
   punt-alarmen is vals. Dat is een klinische schade (genegeerde alarmen → gemiste echte hypo).
2. **Label-gevoeligheid.** `evaluate-predictions.mjs` labelt op losse `<4.0/<4.5` per meting. Een
   striktere, klinische definitie verschuift de cijfers fors (ROC 0.74→0.69). Tuning op een zwak
   label is misleidend.
3. **Punt- vs event-niveau.** Alle metrieken tot nu zijn punt-niveau; een gebruiker ervaart
   *events* (één daling = één alarm), niet losse minuten.

## Doel

De **bestaande** V1/V2-alarmen evalueren en tunen op **event-niveau** met een **klinisch label** en
een expliciet **vals-alarm-budget** — zonder nieuwe features, zonder de live-flow te breken.

## Niet-doelen

- Geen nieuwe predictie-features (vorm/RIG/variabiliteit — afgerond, geen winst).
- Geen closed-loop/insuline-tooling.
- Geen zwaar model (overfit op N=1).

## Definities (klinisch + meet-technisch)

- **Hypo-event:** glucose <3.9 mmol/L (Level-1) dat **≥15 min aanhoudt** (ruis-tolerant: ≥60% van
  de metingen <3.9 in dat venster). Level-2/ernstig: <3.0. Sluit aan op internationaal consensus.
- **Alarm-event:** een aaneengesloten reeks punt-alarmen wordt geconsolideerd tot één event
  (merge-gap bv. ≤15 min), zoals `evaluate-hypo-detector.mjs` al doet met `mergeGapMs`.
- **True positive (event):** een alarm-event dat ≤30 min vóór een hypo-event begint.
- **Lead-time:** minuten van alarm-start tot hypo-onset (verdeling, niet alleen mediaan).
- **Vals-alarm-budget:** doel-bovengrens voor vals-alarm-events per dag (bv. ≤X/dag); operating
  threshold wordt daarop gekozen i.p.v. op een vaste score-drempel.

## Aanpak (hergebruik bestaande infra)

- `scripts/evaluate-hypo-detector.mjs` heeft al **event-/onset-logica** (`findOnsets`, `mergeGapMs`,
  windowMs, predictiveFloor) — dáár bouwen we op, niet vanaf nul.
- `scripts/evaluate-predictions.mjs` is de **productie-labeler** (schrijft outcome op snapshots,
  voedt training/tuning). Hier voorzichtig: niet stilletjes de definitie omgooien (zie risico's).
- `prediction_snapshots` + `compare-v1-v2-deployed.mjs`-aanpak = de getrouwe "as-deployed" bron.

## Milestones

**M1 — Gedeelde eval-metrics + klinisch event-label. [GEDAAN]**
- [x] `scripts/lib/eval-metrics.mjs`: sustained-event-label (<3.9, ≥15m), alarm-event-consolidatie
      (merge-gap), event-scoring met detectie-tolerantie (sensorlag), lead-time, + ranking-helpers
      (rocAuc/averagePrecision). Self-test via `npm run alarm:check`.

**M2 — Event-niveau nulmeting van V1/V2 (as-deployed). [GEDAAN]**
- [x] `scripts/evaluate-alarm-quality.mjs` (`npm run alarm:quality`). Resultaat (14,8 dagen, 39 echte
      hypo-events): **V1 recall 0.97, vals-alarm 12,8/dag, lead 23m; V2 recall 0.97, vals-alarm 14,4/dag,
      lead 23m.** Recall is hoog (beter dan punt-niveau suggereerde); V1≈V2 op event-niveau.
- **Beslispunt: JA, vals-alarm/dag is te hoog (~13/dag, precisie ~0.14) → door naar M3.** Ruimte is er:
      hoge recall + 23m lead laat zich inruilen voor veel minder valse alarmen.

**M3 — Operating-point op een vals-alarm-budget. [GEDAAN]**
- [x] `scripts/tune-alarm-threshold.mjs` (`npm run alarm:tune`). Veegt event-niveau over drempels per
      detector. Resultaat (70,7 dagen, 53 events):
      - **V2 ≫ V1 budget-beperkt:** V2 ≤3/dag recall 0.85 lead 6m; ≤5/dag recall 0.98 lead 6m. V1 haalt
        recall alleen met lead 1m (detecteren, niet voorspellen) → V2-als-primair herbevestigd.
      - **Harde frontier:** lange lead (30m) komt mét ~29 valse alarmen/dag; terug naar ~4/dag laat de
        lead instorten naar ~6m. Vroege waarschuwing = dezelfde lage-confidence-signalen als de valse
        alarmen. Met CGM-alleen kun je NIET tegelijk weinig vals-alarmeren én vroeg waarschuwen.
- **Gevolg:** dit bevestigt waarom context-data de enige echte hefboom is. Bruikbaar CGM-only werkpunt:
      V2 ≤5/dag (recall 0.98, lead 6m). Caveat: drempel op recompute-schaal (DEFAULT_PARAMS, geen
      pattern), niet 1:1 de live-config — de frontier-vorm is leidend, niet het exacte getal.
- Profielneutraal: budget configureerbaar, geen persoonlijke hard-coding.

**M4 — Recall-vangnet (V2 mist iets meer dan V1).**
- [ ] Test **V1 ∨ V2-unie** of een recall-ondergrens, zodat V2's vals-alarm-winst geen echte hypo's
      kost. Vergelijk op event-niveau tegen V2-alleen.

**M5 — Gegradeerde waarschuwing. [GEMETEN — werkt; bouwen = tiers kalibreren]**
- [x] `scripts/evaluate-graded-alarm.mjs` (`npm run alarm:graded`). Resultaat (70,8 dagen, 55 events):
      **WATCH** (≤12/dag, zacht) recall 1.0, lead 19m; **URGENT** (≤3/dag, indringend) recall 0.855,
      lead 6m; 47/55 events escaleren, WATCH waarschuwt mediaan 8m eerder. Lost het M3-dilemma op:
      geen keuze nodig tussen vroeg en weinig-vals.
- **Bouwen ≠ from scratch:** de V2-detector heeft al `watch/high/urgent`. De ingreep is die tiers
      kalibreren op deze werkpunten **en de WATCH-UI passief maken** (subtiele kleur/badge, geen
      geluid/push) — de hele winst hangt op niet-indringende WATCH (anders 12/dag = moeheid).
- **Aandacht:** URGENT mist ~15% (escaleert niet), maar die events krijgen wél WATCH (recall 1.0),
      dus niets wordt volledig gemist. Drempels (10/20) zijn recompute-schaal → live mappen/kalibreren.
- **Open (bouwfase, live-wijziging):** achter omkeerbare flag, shadow-meten, `--force-recreate nightscout-ui`.

## Risico's & waarborgen (senior)

1. **De productie-labeler voedt training/tuning.** `evaluate-predictions.mjs` bepaalt `result`/
   `actual*`-velden die `train-risk-model`/de tuner gebruiken. De nieuwe sustained-definitie eerst
   **náást** de oude rapporteren (niet vervangen); pas overschakelen samen met een retrain, anders
   verschuift de trainings-target ongemerkt.
- 2. **Drempel-wijziging = live alarm-gedrag.** M3 raakt wat de gebruiker ziet → achter omkeerbare
   flag, shadow-meten vóór activeren, `--force-recreate nightscout-ui`.
3. **Event-definitie-keuzes (merge-gap, 15m, 30m horizon) sturen de cijfers.** Maak ze expliciete,
   gedocumenteerde constanten; rapporteer gevoeligheid.
4. **N=1.** Budget/drempels zijn voor deze persoon; houd ze configureerbaar (profielneutraal).

## Stop-condities

- Event-niveau vals-alarm/dag blijkt al laag/acceptabel → geen drempel-wijziging nodig; klaar na M2.
- Geen drempel haalt het budget zonder onaanvaardbare recall-daling → escaleer naar context-data
  (buiten dit plan).

## Reproduceerbaarheid

Bestaand: `npm run v1v2:deployed`, `hypo:backtest` (`evaluate-hypo-detector.mjs`).
Nieuw: `eval:check`, en een event-niveau rapport-script. Rapport: `reactieve-hypo-onderzoeksrapport.md`.
