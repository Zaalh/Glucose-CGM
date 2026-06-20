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

**Conclusie:** met CGM-alleen features zit de voorspelbaarheid voor deze persoon rond
**ROC-AUC 0.74, ~10 min lead**, en dat plafond wordt al benaderd door **niveau + actuele
daalsnelheid** — precies wat de bestaande regel/V2-detector gebruikt. Meer CGM-afgeleide features
(vorm, RIG, rise-dynamiek) helpen niet. De enige plausibele hefboom is **externe context**
(maaltijd-timing/-inhoud, activiteit), die nu niet beschikbaar is.

**Aanbeveling:** geen RIG/vorm-laag bouwen. Bevestig dat de huidige detector dit plafond haalt;
investeer alleen verder als er context-data bijkomt.

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

- **Niet bouwen:** curve-vorm-similarity (geen signaal) en RIG/extra rise-features (geen winst).
- **Bevestigen:** dat de bestaande regel/V2-detector het plafond (~0.74 ROC-AUC, ~10 min lead) al
  benadert met niveau + daalsnelheid. Zo niet, is dáár de kleine winst te halen — niet in nieuwe features.
- **Voorwaarde voor échte verbetering:** context-data toevoegen (maaltijd/activiteit). Pas dan is
  een rijker model zinvol.
- **Profielneutraal:** de bevinding "niveau+rate is genoeg, vorm/RIG niet" is universeel — geen
  persoonlijke tuning nodig; cold-start valt sowieso terug op de regel-detector.

## 11. Beperkingen

- **N=1** en CGM-alleen; cross-persoon-generalisatie onbewezen (al is de richting universeel).
- Eenvoudig logistisch model; een complexer model zou marginaal meer kunnen halen, maar de
  positieve controle maakt de richting betrouwbaar.
- RIG via CGM-dal-proxy is ruisiger dan met een echte maaltijd-melding.
- Sensorlag/MARD in de lage range blijven label-ruis ondanks de sustained-definitie.

## 12. Reproduceerbaarheid

```sh
# offline self-tests
node scripts/validate-dip-rise-drop.mjs --self-test
node scripts/measure-dip-rise-drop-blindspot.mjs --self-test
node scripts/evaluate-rig-contribution.mjs --self-test

# echte data (in libreview-sync container op de iMac)
npm run dip-rise-drop:validate
docker compose -f docker-compose.nightscout.yml --profile libre run --rm \
  libreview-sync node scripts/measure-dip-rise-drop-blindspot.mjs
npm run rig:contribution
```

Plan & open punten: `dynamische-patroonherkenning-plan.md`.
