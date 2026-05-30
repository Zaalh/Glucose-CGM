# Plan: reactieve hypo/hyper-voorspelling — snelheid, versnelling & symmetrie

Status: **plan, nog niet gebouwd.** Vervolg op [predict.md](./predict.md). Doel: de
voorspel*snelheid* kloppend maken voor jouw snelle reactieve hypo's, hyper symmetrisch
meenemen (piek vóórspelt crash), en de drie losse modellen terugbrengen tot één bron.

## 0. Context na de besluiten

- **React-app gaat weg** (in een andere chat). Hier bouwen we niet op `src/`.
- Live-keten = **sync (brein)** + **overlay (UI, poort 1337)**. De sync en overlay
  verwijzen nergens naar `src/` → schoon te scheiden.
- Surfaces vallen van 3 → 2, en feitelijk 1 zichtbaar (de overlay). Daarmee verdwijnt
  vanzelf de inconsistentie tussen modellen; rest is sync ↔ overlay laten overeenkomen.

## 1. Probleemanalyse (waarom de snelheid nu niet klopt)

| Bevinding | Plek | Gevolg |
|---|---|---|
| Twee verschillende rate-blends | sync [`blendRate`](scripts/libreview-nightscout-sync.mjs#L322) (0.5/0.33/0.17) vs overlay [`getForecastRateMmol`](nightscout-overlay/rate-overlay.js#L210) (0.45/0.30/0.17/0.08) | brein en UI tonen andere snelheid |
| **Pure rate, geen versnelling** | beide | loopt achter op de omslag piek→daling, juist jouw kritieke moment |
| Geen hyper-output | [`buildForecast`](scripts/libreview-nightscout-sync.mjs#L299) heeft alleen `lt45`/`lt40` | piek wordt niet als vóórspeller van de crash benut |
| Training landt nergens | brein [`evaluateRiskRuleV1`](scripts/libreview-nightscout-sync.mjs#L406) hardcodet 7/5/3; `risk-model-state.json` zegt 2/3/5 en werd alleen door React gelezen | offline leerwerk doet live niets |
| Meetbare onderprestatie | `risk-model-state.json` metrics | recall **0.52** (mist ~helft), precision **0.15** (~85% vals alarm) |

Jouw timing uit de data ([predict.md:65-73](predict.md)): na piek >10 mmol/L onder 5.0 in
mediaan **25 min** (snelste 16), onder 4.0 na **~22 min**. Kritieke venster: **eerste
15–30 min na de piek**. Dit zijn de getallen waarop we de piek-modus afstellen.

## 2. Ontwerp

### 2.1 Eén snelheidsbron — brein rekent, overlay toont
- De overlay prefereert al de DB-forecast als de entry matcht
  ([rate-overlay.js:521](nightscout-overlay/rate-overlay.js#L521)). Dat wordt de **regel**:
  de overlay toont de forecast van het brein; eigen rate-projectie alleen als fallback bij
  stale/ontbrekende snapshot.
- Beide gebruiken dezelfde rate-bron: de vooraf berekende `glucoseRateMmolPerMin`-vensters
  die de sync al per entry schrijft ([`addRateFields`](scripts/libreview-nightscout-sync.mjs#L790)).
  Niets dubbel herberekenen (predict.md-regel: "gebruik wat al in entries staat").
- **Per-minuut benut.** De data is ~1-min (geverifieerd, §7) en er staan al rates op élke
  minuut 1..15 klaar ([RATE_WINDOWS_MINUTES](scripts/libreview-nightscout-sync.mjs#L14)).
  Daarom geen grove 3-venster-blend maar een **weighted linear regression over de laatste
  ~10-15 één-minuut-`sgv`-punten** (echte timestamps → een gemiste minuut deert niet),
  met median-guardrail tegen één-punts-ruis. De precomputed 5/10/15-vensters blijven als
  goedkope fallback/cross-check. Geen kwadratische fit ([CLAUDE.md](CLAUDE.md) waarschuwt
  daar terecht voor).

### 2.2 Versnellingsterm (de kern van "snelheid klopt")
- Echte versnelling, dimensioneel correct: `accel = (rate5m − rate15m) / Δt` in
  **mmol/min²**, waarbij `Δt` de afstand tussen de midpoints van het 5- en 15-min venster
  is (≈10 min). `rate5m − rate15m` alleen (mmol/min) zou ~10× te groot doorwerken in een
  kinematische term.
- Ruisdemping: alleen meetellen als versnelling **2 metingen achtereen** dezelfde richting
  heeft (1-min data is ruizig); en de bijdrage cappen (zie 2.3).
- **Gap-bewust**: bereken helling/versnelling nooit óver een gat. Gebruik alleen punten met
  onderlinge afstand ≤ ~3 min binnen het venster; bij een groter gat het venster inkorten
  tot ná het gat. Zie 2.5.
- Normale projectie (Loop-stijl decay), horizon T:
  `verplaatsing(H) = rate·(H − H²/(2T))`, `T = 20`. Versnelling alléén actief in de
  snelle modus (2.3), niet in de normale projectie.

### 2.3 Piek-getriggerde meal-state machine
Implementeer de states uit [predict.md §800-860](predict.md) in het brein; sla `mealState`
op in het snapshot; overlay toont de staat.

```
idle → possible_meal   rate10m > +0.05 mmol/min
     → meal_spike       peakMmol ≥ 8.5  OF  piek ≥ baseline + 2.0
     → peak_watch        stijging vlakt af (rate ≤ +0.02 na spike)
     → drop_watch        eerste negatieve rate na piek (rate5m < -0.01)
     → fast_drop_risk    dropFromPeak ≥ 2.0 (piek≥10) / ≥2.5 (piek 9–10) /
                         ≥2.0 met doorlopende daling, ≤45 min na piek
     → near_hypo (<4.5) → hypo (<4.0) → recovery
```

In **`drop_watch` / `fast_drop_risk`** schakelt de projectie naar snelle modus:
- minder demping: `T = 30`
- versnelling meegerekend (kinematisch met `accel` in mmol/min² uit 2.2):
  `+ 0.5·accel·H²`, gecapt op bijv. ±1.0 mmol zodat hij niet wegloopt
- de **vector/pattern-drop-correctie** eerder toegepast: `corrWeight = min(1, H/20)` i.p.v.
  `H/30`, via de al-werkende [`findSimilarEpisodes`](scripts/libreview-nightscout-sync.mjs#L263)
  op de klaarstaande `episode_vectors` (34 episodes).
- **sensor-lag-compensatie** (alleen hier, zie 2.5): interstitieel loopt achter en vlakt af
  bij snelle swings, dus de projectie iets vóór laten lopen — de echte waarde is
  waarschijnlijk al lager dan de sensor toont.

Effect: na een piek >10 zit je in `fast_drop_risk` vóórdat je onder 5.0 bent — precies wat
[predict.md:845](predict.md) eist.

### 2.4 Symmetrische hyper (piek koppelt aan crash)
- **`probAbove(value, threshold)`** — spiegel van [`probBelow`](scripts/libreview-nightscout-sync.mjs#L343),
  zelfde logistische steilheid (2.4).
- `probabilities` in `buildForecast` uitbreiden met **`gt100`** en **`gt139`** naast
  `lt45`/`lt40`. `predictedMmol` is al symmetrisch (positieve `baseRate` werkt al).
- **Hyper-tak** in `evaluateRiskRuleV1`: scoor snelle stijging / hoge piek.
- **Voorwaartse koppeling** — het kernpunt "ze hangen samen": bij `meal_spike`/`peak_watch`
  een vooruitziend hypo-risico afgeven ("piek X mmol → bij jou vaak crash binnen ~20 min"),
  i.p.v. te wachten tot de daling al telt. Reden uit de episode-similarity.
- **Overlay**: hyper-regel + "piek gezien → let op daling" in de hypokaart
  ([`renderHypoAlert`](nightscout-overlay/rate-overlay.js#L1047)).

### 2.5 Datakwaliteit, gaten & sensor-lag

De sensor logt intern en de telefoon **backfillt** bij herstel; de sync absorbeert late
minuten via de stabiele `identifier` (geen duplicaten). Daardoor heelt de *historie* zich
grotendeels vanzelf — in 3 dagen data was het grootste gat 6 min. Twee dingen blijven:

**A. Live moment ≠ historie.**
- **Recency-gate**: een *verse* forecast/alarm alleen als de nieuwste reading < ~3-4 min oud
  is. Anders: laatste waarde tonen, maar geen nieuw hard alarm (stale-concept — leeft nu in
  sync/overlay, niet meer in de vertrekkende React `checkStale`).
- **Post-gap guard**: na een gat > ~5 min is het eerste nieuwe punt geen "snelle rate"
  (delta ÷ gaptijd is nep). Pas fast_drop_risk weer toelaten na ≥2 verse opeenvolgende
  punten.
- **Resolutie-gaten**: sommige 4-6 min gaten zijn LibreLinkUp-historieresolutie, geen echt
  verlies → niet over-interpoleren alsof het 1-min data is (regressie op echte timestamps).

**B. Sensor-lag bij snelle swings** (interstitieel loopt ~5-15 min achter en vlakt af):
- In `drop_watch`/`fast_drop_risk` de projectie iets vóór laten lopen (horizon-shift) —
  de echte waarde is bij een snelle crash waarschijnlijk al lager dan de sensor toont.
- **Afvlakking-argwaan**: een plotse afvlakking ná een snelle daling kan sensor-saturatie
  zijn, geen echt herstel → `recovery` pas bevestigen na ≥2-3 stijgende punten; tot dan
  blijft fast_drop_risk staan.
- **Compressie-low** (nachtelijk, op de sensor liggen): snelle daling+herstel met laag
  vertrouwen → minder hard alarmeren (predict.md §1072/§1085).

**Context beslist** de spanning lag↔gaten: na een echte piek (fast_drop_risk) leunt het
model agressief (lag); bij een gat/laag vertrouwen tempert het. Een `dataQuality`-vlag in
het snapshot stuurt dat: *laag vertrouwen = voorzichtig tonen, minder hard alarmeren tenzij
trend én context sterk zijn* (predict.md-regel).

### 2.6 Training landt live
- `evaluateRiskRuleV1` **leest** `risk-model-state.json`-drempels i.p.v. hardcoded 7/5/3
  (of het `model_state`-document in Mongo dat hetzelfde script al schrijft).
- Daarmee herijkt `npm run model:retrain` direct de live-drempels op jouw false
  positives/negatives (predict.md fase 2).

## 3. Wijzigingen per bestand

**Sync — [scripts/libreview-nightscout-sync.mjs](scripts/libreview-nightscout-sync.mjs)**
- geünificeerde rate-blend (deelt formule met overlay)
- versnellingsterm in `buildForecast`
- meal-state machine + `mealState` in snapshot
- `probAbove` + `gt100`/`gt139`
- hyper-tak + voorwaartse koppeling in `evaluateRiskRuleV1`
- drempels lezen uit getraind model i.p.v. hardcoded

**Overlay — [nightscout-overlay/rate-overlay.js](nightscout-overlay/rate-overlay.js)**
- rate-blend gelijktrekken met brein; DB-forecast als primaire bron, lokale projectie als
  fallback
- versnelling in `getForecastRateMmol`/`horizonPredictionText`
- hyper-regel + meal-state in de hypokaart

**Evaluatie — `scripts/evaluate-predictions.mjs`**
- hyper-uitkomsten (`gt100`/`gt139`) en lead-time **per meal-state** meten

**Docs — [CLAUDE.md](CLAUDE.md), [predict.md](predict.md)**
- live-flow = sync + overlay; meal-state, hyper-probs en model-state-lezen documenteren

## 4. Fasering

1. **Eén snelheidsbron + versnelling** (2.1–2.2) — meeste winst, laag risico.
2. **Piek-getriggerde meal-state** (2.3).
3. **Symmetrische hyper** (2.4).
4. **Training live + validatie** (2.6 + §5).

## 5. Validatie (op je eigen historie, niet op gevoel)

Met de bestaande pipeline:
1. `npm run snapshots:backfill` + `npm run snapshots:evaluate` met het nieuwe model.
2. `npm run model:retrain` → herijkte drempels.
3. Meet (predict.md §1437-1452), oud vs nieuw:
   - **lead time** bij snelle post-hyper drops
   - gemiste hypo's **<30 min na piek**
   - false alarms / dag
   - recall & precision (baseline nu: **0.52 / 0.15**)

**Acceptatiecriteria (eerste versie):**
- ≥ 10–20 min eerdere waarschuwing bij snelle post-hyper dalingen
- geen alarm na élke maaltijd
- recall omhoog én false-alarm-ratio omlaag t.o.v. de baseline

## 6. Risico's & mitigatie

| Risico | Mitigatie |
|---|---|
| Versnelling ruizig op 1-min data | median-guardrail + 2 metingen achtereen vereisen |
| Piekdetectie vals getriggerd | aanhoudende stijging eisen voor `meal_spike` |
| Sync/overlay lopen weer uiteen | één formule; overlay prefereert DB-forecast |
| Lange horizons (120/180) lopen weg | bestaande `RATE_DECAY_TAU`-saturatie behouden |

## 7. Meetcadans — geverifieerd (2026-05-30)

Gemeten op de live MongoDB (iMac), device `glucose-cgm-libreview`, 3360 entries:

| Statistiek | Waarde |
|---|---|
| Mediaan interval | **60s** (p10 59s, p90 65s) |
| ≤70s (echt 1-min) | 3079 / 3359 = **92%** |
| Kleine gaten | ~95× ~2min, 22× ~3min |
| Grotere gaten | 163× 4-6min (~5%), max **362s (6 min)** |

**Aanname bevestigd: ~1-min, consistent, geen grote gaten.** Daarmee gelden:
- versnelling `Δt ≈ 10 min` (midpoints 5/15-min venster) is geldig;
- gap-grens 6 min is veilig en wordt zelden geraakt;
- de ~5% gaten van 4-6 min worden al afgevangen doordat de rate-vensters `null` geven als
  er geen baseline binnen 45s van het doel is ([`findBaseline`](scripts/libreview-nightscout-sync.mjs#L829),
  `RATE_MAX_BASELINE_DIFF_MS`), dus de blend valt vanzelf terug — geen harde uitschakeling
  nodig.

Geen open aannames meer vóór fase 1.
