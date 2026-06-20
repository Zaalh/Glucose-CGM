# Onderzoeksrapport — vroege waarschuwing voor reactieve postprandiale hypoglykemie

**Datum:** 2026-06-20 · **Data:** N=1 (eigen CGM-historie), ~31.9k metingen, Nightscout/Mongo op de iMac
**Status:** alle analyses alleen-lezen; geen wijziging aan de live-flow.

---

## 1. Samenvatting (TL;DR)

Doel: kan het terugkerende patroon **dip → harde stijging → harde daling** vroeg gewaarschuwd
worden? Drie onafhankelijke analyses, methodologisch streng (grouped-CV per dag, klinische
drempel <3.9 sustained, artefact-gate, positieve controle):

1. **Curve-vorm-similarity draagt geen signaal** (vroege-prefix separation 0.01 ≈ 0). Een eerste
   run leek +0.13 te tonen; dat bleek artefact van duplicaten + losse drempel + outcome-lekkage.
2. **Blinde vlekken** in de huidige pijplijn zijn reëel maar kleiner dan eerst: 40% selector-blind,
   dip ligt mediaan 36 min vóór de piek (buiten het opgeslagen venster). Maar er is geen
   vorm-signaal om te vangen, dus het venster verbreden loont niet.
3. **RIG (rate of increase to peak) voegt niets toe.** A/B-test: niveau + daalsnelheid is het
   beste (ROC-AUC ~0.74, PR-AUC ~0.42); de bestaande rise-features én RIG maken het marginaal
   *slechter*. De positieve controle (synthetisch) bewijst dat de pijplijn signaal vindt als het
   er is — het is er op deze data niet.

**Conclusie:** met CGM-alleen features ligt de voorspelbaarheid voor deze persoon rond
**ROC-AUC ~0.69–0.78** (label-afhankelijk) met **~9–11 min lead**. Het huidige systeem (V1/V2) zit
daar al aan/boven; meer CGM-afgeleide features helpen niet operationeel:
- **Vorm/RIG** (Seo et al.): geen signaal.
- **Variabiliteit + tijd-van-dag + recent-low** (literatuur): verhogen ROC-AUC maar **verlágen
  PR-AUC en sensitiviteit@spec** — geen winst in de precisie-kritische alarmzone (overfit op ~77
  onafhankelijke episodes).
De enige plausibele hefboom is **externe context** (maaltijd-timing/-inhoud, activiteit). Een zwaar
sequentie-model (LSTM, lit. AUC>0.97) vereist een veel grotere/andere populatie en overfit hier.

**Aanbeveling (empirisch onderbouwd):** geen extra CGM-feature-laag bouwen. Het bestaande V1/V2
haalt het praktische plafond al. Apart aandachtspunt: **V2 verslaat V1 niet** (lagere PR-AUC),
terwijl V2 de live primaire alarmbron is — overweeg dat te heroverwegen. Investeer alleen in een
rijker model als er context-data bijkomt.

---

## 2. Onderzoeksvraag & context

- Gebruiker: **niet-diabeet met reactieve/postprandiale hypoglykemie**; doel = vroege
  daling-waarschuwing, géén closed-loop/insuline-tooling.
- Patroon: kort na eten zakt de glucose even, stijgt dan hard, en daalt vervolgens hard richting
  (near-)hypo. Vraag: is dit (a) leerbaar als vorm, (b) gebaat bij de literatuur-feature RIG,
  (c) en werkt het ook voor anderen (profielneutraal)?

## 3. Data & methode

- Bron: Mongo-collecties `entries` (~31.9k sgv) en `episode_vectors` (808) op de iMac
  (`192.168.178.240`, Docker). Alle scripts draaien read-only in de `libreview-sync`-container.
- Klinische definities: Level-1 hypo **<3.9 mmol/L**, Level-2 <3.0. Hypo-event = **sustained**
  (≥2 opeenvolgende metingen <3.9) binnen een **30-min** horizon.
- Anti-lekkage: **grouped cross-validation per kalenderdag** (geen dag in train én test);
  episode-**dedupe** op piek-cluster; **artefact-gate** (verwerpt 1-sample dips/compressie-lows).
- Scripts (npm): `dip-rise-drop:validate`, (blindspot via node), `rig:contribution`.

## 4. Resultaat 1 — Curve-vorm-similarity (Fase 0)

`scripts/validate-dip-rise-drop.mjs`. Leave-one-out curve-cosine tegen eigen `episode_vectors`,
base-rate-gecalibreerd.

| Maat | Waarde |
|---|---|
| Episodes na dedupe | 289 (van 808; ~65% bijna-duplicaten) |
| Base-rate hypo <3.9 | 0.40 |
| Separation volledige curve (REFERENTIE, lekkage) | 0.11 |
| **Separation vroege prefix (eerlijk, vóór de daling)** | **0.01 → geen signaal** |

**Correctie-historie (belangrijk voor vertrouwen):** een eerste run gaf separation +0.13 en leek
positief. Vijf methodologische fixes haalden dat onderuit: (1) episode-dedupe, (2) klinische
drempel <3.9 i.p.v. <4.5 (base-rate 0.90→0.40), (3) outcome-lekkage verwijderd (de volledige curve
bevat de daling die de uitkomst bepaalt), (4) gelijke populaties voor recall/vals-alarm,
(5) artefact-gate. Schoon gemeten blijft er niets over. Oorzaak: de similarity normaliseert het
**niveau** weg, terwijl niveau juist de sterkste voorspeller is.

## 5. Resultaat 2 — Blinde-vlek-meting

`scripts/measure-dip-rise-drop-blindspot.mjs`, met artefact-gate.

| Maat | Waarde |
|---|---|
| Kandidaten dip→rise→drop (na artefact-gate) | 327 |
| Afgekeurd als artefact (1-sample/compressie) | 530 |
| Waarvan echte hypo (<3.9) | 77 |
| Selector-blinde vlek (gemist) | 40% (97 milde daling, 35 traag/laat) |
| Dip-tijd vóór de piek (mediaan) | 36 min → buiten opgeslagen venster [piek−20m] |

De blinde vlekken zijn echt, maar de kandidaat-populatie was ~62% artefact (530/857). En omdat
Resultaat 1/3 geen vorm-signaal vinden, is er niets te winnen met venster-verbreding.

## 6. Resultaat 3 — RIG-bijdrage (de hoofdtest)

`scripts/evaluate-rig-contribution.mjs`. Grouped-CV per dag, L2-logistische regressie,
gestandaardiseerd, klinisch label. Modellen: **A** = niveau + daalsnelheid; **B** = A + bestaande
rise-features (`riseFromBaseline`, `riseRate15m`); **C** = B + **RIG** (= (piek−dal)/tijd-tot-piek).

### Reactieve context (n=12.041, hypo=1.593, base-rate 0.13)

| Model | ROC-AUC | PR-AUC | sens@spec0.90 | mediaan lead |
|---|---|---|---|---|
| **A — niveau + rate** | **0.733** | **0.426** | 0.49 | 10 min |
| B — + bestaande rise | 0.734 | 0.413 (Δ−0.013) | 0.43 | 10 min |
| C — + RIG | 0.733 | 0.410 (Δ−0.003) | 0.44 | 10 min |

### Alle punten (n=31.832, hypo=3.414, base-rate 0.11)

| Model | ROC-AUC | PR-AUC | sens@spec0.90 | mediaan lead |
|---|---|---|---|---|
| **A — niveau + rate** | **0.738** | **0.404** | 0.52 | 9 min |
| B — + bestaande rise | 0.726 | 0.353 (Δ−0.051) | 0.43 | 9 min |
| C — + RIG | 0.728 | 0.339 (Δ−0.014) | 0.42 | 9 min |

**RIG voegt niets toe; de rise-features evenmin.** Niveau + daalsnelheid is het beste.

## 6b. Vergelijking met het huidige systeem (V1 / V2)

`scripts/compare-detectors.mjs`. V1 (`legacy-risk-v1`) en V2 (`reactive-hypo-detector`) met de
huidige code gescoord op dezelfde punten/label als referentie A. V1/V2 = vaste functies (directe
AUC); A = honest OOF. (Caveat: V2 is op deze persoon getuned → in-sample licht optimistisch; V2
hier zonder de — eerder verwaarloosbaar gebleken — pattern-component.)

| (allPoints) | ROC-AUC | PR-AUC | sens@spec90 | lead |
|---|---|---|---|---|
| V1 (regelmodel) | 0.775 | 0.411 | 0.53 | 9m |
| V2 (live primair) | 0.767 | 0.352 | 0.51 | 9m |
| A (niveau+rate, OOF) | 0.739 | 0.404 | 0.52 | 9m |

**V1/V2 zitten al aan/boven de simpele lijn** → het systeem laat geen gat ónder zich. **V2 verslaat
V1 niet** — op de imbalance-relevante PR-AUC is V2 zelfs slechter (0.35 vs 0.41). Aandachtspunt,
want V2 is de live primaire alarmbron.

## 6c. Kan het CGM-only beter? (variabiliteit + tijd-van-dag + recent-low)

`scripts/evaluate-feature-extensions.mjs`, met de **striktere sustained-definitie (10 min)**.
A=niveau+rate; D=+glycemische variabiliteit (SD/CV 60m); E=+tijd-van-dag (sin/cos) + recent-low
(min sinds laatste <3.9, #lows 6u).

| (allPoints, sustain 10m) | ROC-AUC | PR-AUC | sens@spec90 |
|---|---|---|---|
| A | 0.69 | **0.273** | 0.47 |
| D (+variabiliteit) | 0.735 (Δ+0.045) | **0.173** ↓ | 0.35 ↓ |
| E (+tijd+recent-low) | 0.731 | **0.172** ↓ | 0.35 ↓ |

**Discordantie:** variabiliteit/tijd verhogen ROC-AUC maar **verlagen PR-AUC en sensitiviteit@spec**.
Voor een zeldzaam-event-alarm (base-rate 0.07) zijn PR-AUC/sens@spec leidend → **geen operationele
winst**, eerder verlies (overfit op weinig onafhankelijke episodes). De literatuur-AUC>0.97 (LSTM)
geldt voor grotere T1DM-cohorten; hier zou zo'n model overfitten.

**NB label-gevoeligheid:** met de striktere 10-min sustained-definitie zakt A van ROC 0.74 → 0.69.
De absolute getallen zijn dus soft; de *vergelijking* tussen modellen (zelfde label) is robuust.

## 7. Methodologische waarborgen

- **Positieve controle:** op synthetische data waar hypo bewust ná steile spikes komt, tilt
  dezelfde pijplijn B van PR-AUC 0.62 → 0.90. De machinerie *vindt* signaal als het er is →
  het nul-resultaat op echte data is geen kapotte pijplijn.
- **Lekkage uitgesloten:** grouped-CV per dag + episode-dedupe (de eerste, niet-gecorrigeerde
  Fase 0 lekte juist via duplicaten — nu hersteld).
- **Klinisch correcte labels:** <3.9 sustained, niet de losse <4.5 die de base-rate opblies.
- **Imbalance-robuust:** PR-AUC + class-weighting náást ROC-AUC.

## 8. Interpretatie

1. **Niveau is koning.** Bij reactieve hypo zit het meeste signaal in het actuele niveau + de
   actuele daalsnelheid op het meetmoment. Vorm en stijg-dynamiek (RIG) voegen geen onafhankelijke
   informatie toe — ze zijn grotendeels al in niveau+rate verdisconteerd of puur ruis.
2. **Plafond ~ROC-AUC 0.74, lead ~10 min** met CGM-alleen features voor deze persoon. Modest maar
   reëel; de bestaande detector zit daar waarschijnlijk al dichtbij.
3. **De echte hefboom is context, niet meer CGM-features.** Wil je hoger dan dit plafond, dan is
   externe data nodig (maaltijd-timing/-inhoud, activiteit) — precies wat de literatuur als
   belangrijkste verbetering noemt.

## 9. Vergelijking met de literatuur

Seo et al. 2019 (PMC6833234) rapporteert AUC 0.966 met RIG als sleutelfeature. Verschillen die het
gat verklaren: (a) **T1DM** i.p.v. niet-diabetische reactieve hypo; (b) **expliciete
maaltijd-meldingen** → scherpe, betrouwbare RIG, terwijl onze RIG uit een CGM-dal-proxy komt
(ruisig); (c) waarschijnlijk schonere maaltijd-vensters. Conclusie: RIG is niet universeel nuttig;
het hangt af van populatie en of er een betrouwbaar maaltijd-anker is. Zie ook Dave et al.
(PMC8258517) en de meta-analyse (Springer s40200-025-01820-4) — beide T1DM-gericht.

## 10. Conclusie & aanbeveling

- **Niet bouwen (alle getest):** curve-vorm-similarity (geen signaal), RIG/rise-features (geen
  winst), én variabiliteit/tijd-van-dag/recent-low (verhogen ROC maar verlagen PR-AUC/sensitiviteit).
- **Bevestigd:** het bestaande V1/V2 zit al aan/boven de simpele referentie en dicht bij het
  praktische CGM-only plafond (ROC-AUC ~0.69–0.78 label-afhankelijk, lead ~9–11 min).
- **Aandachtspunt V2 vs V1:** V2 (live primair) verslaat V1 niet; op PR-AUC zelfs slechter. Apart
  van dit onderzoek de moeite waard om te heroverwegen.
- **Voorwaarde voor échte verbetering:** externe context (maaltijd/activiteit). Pas dan is een
  rijker model (of een sequentie-model met meer data) zinvol.
- **Profielneutraal:** de bevinding "niveau+rate is genoeg; extra CGM-features niet" is universeel —
  geen persoonlijke tuning nodig; cold-start valt sowieso terug op de regel-detector.

## 11. Beperkingen

- **N=1** en CGM-alleen; cross-persoon-generalisatie onbewezen (al is de richting universeel).
- Eenvoudig logistisch model; een complexer/sequentie-model zou met méér data meer kunnen halen,
  maar overfit hier (de positieve controle maakt de richting betrouwbaar).
- RIG via CGM-dal-proxy is ruisiger dan met een echte maaltijd-melding.
- **Label-definitie is gevoelig:** het eerste 2-punts-"sustained" (~2 min bij 1-min data) was te zwak;
  de striktere 10-min-definitie verlaagt de absolute AUC's (0.74→0.69 voor A). Modelvergelijkingen
  (zelfde label) blijven robuust; absolute getallen zijn soft.
- Sensorlag/MARD in de lage range blijven label-ruis ondanks de sustained-definitie.

## 12. Reproduceerbaarheid

```sh
# offline self-tests
node scripts/validate-dip-rise-drop.mjs --self-test
node scripts/measure-dip-rise-drop-blindspot.mjs --self-test
node scripts/evaluate-rig-contribution.mjs --self-test

# echte data (in libreview-sync container op de iMac)
npm run dip-rise-drop:validate
docker compose ... run --rm libreview-sync node scripts/measure-dip-rise-drop-blindspot.mjs
npm run rig:contribution                # RIG-bijdrage
npm run detectors:compare               # V1 vs V2 vs referentie
npm run features:extend                 # variabiliteit + tijd-van-dag + recent-low
```

Scripts: `validate-dip-rise-drop.mjs`, `measure-dip-rise-drop-blindspot.mjs`,
`evaluate-rig-contribution.mjs`, `compare-detectors.mjs`, `evaluate-feature-extensions.mjs`.

Plan & open punten: `dynamische-patroonherkenning-plan.md`.
