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

## De echte gaten (na code-toetsing)

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
      gecalibreerd. Uitkomst: zie meetresultaten hierboven (vorm draagt signaal, dip niet vastgelegd).
- [x] Blinde-vlek-meting `scripts/measure-dip-rise-drop-blindspot.mjs`. Uitkomst: 36% selector-
      blinde vlek, 92% window-blinde vlek.
- **Beslispunt (gehaald):** de matcher is niet de bottleneck; window + selector wel. Eerst die
      verbreden (Fase 1) vóór er iets live bijdraagt.

### Fase 1 — Vroege fase mee laten tellen (de dip + rise-onset)

- [ ] Verzacht/verlaag de `isDropContext`-gate in `patternFromFeatures()` zodat een
      terugkerende vorm vroeger signaleert (bijv. lagere `dropFromPeakMmol`-drempel of een
      aparte rise-onset-tak), zonder ruis-stijgingen te laten vuren.
- [ ] Roep `mealPatternFromState()` aan in de sync voor de `rising`/`plateau`-fase, zodat
      ook de aanloop tegen eigen episodes wordt gematcht.
- [ ] Leg de leidende dip vast als onderdeel van de episode-memory (`updateMealEpisodeMemory`)
      zodat de hele vorm (dip→rise→drop) één gematchte signatuur is.
- [ ] Borg met fixtures: nieuwe `meal-fixtures/` voor dip→rise→drop; houd `npm run meal:check` groen.

### Fase 2 — Pattern in de badge-risk (smaller dan eerst gedacht)

> De overlay leest en toont `pattern` al en voedt de forecast. Resteert alleen: de
> maaltijd-badge-escalatie meevoeden.

- [ ] Laat `scoreReactiveMealRisk()` het pattern als score-bijsturing gebruiken
      (niet als phase-beslissing) — conform stap 6 in `mealdetectie.md`.
- [ ] Profielneutraal houden: geen hard-coded klinische aannames; drempels configureerbaar
      (zie `feedback-profile-neutral-ai`).

### Fase 3 — Validatie & uitrol

- [ ] Backtest op echte data: vals-alarm-ratio en lead-time vóór/na, m.n. voor deze vorm.
- [ ] Achter omkeerbare flag uitrollen (zoals `REG_FEEDS_ALARMS`), force-recreate
      `nightscout-ui` (zie deploy-notitie `mealdetectie.md`).
- [ ] CHANGELOG + statusdocs bijwerken.

## Risico's & ontwerpcorrecties (senior review)

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
- Geen nieuw ML-model; we benutten de bestaande similarity-laag.
- V2-detector / §21 ongemoeid tenzij expliciet.
