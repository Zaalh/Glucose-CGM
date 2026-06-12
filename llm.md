# AI-review in de overlay — uitgebreid plan (llm.md)

Status: **Fase 1–4 geïmplementeerd & getest** (deploy naar de iMac is de laatste
stap). Dit document beschrijft het ontwerp om de AI-review als knop + paneel in de
Nightscout-overlay te krijgen, gevoed door Ollama Cloud, met een meegebouwde
periodieke achtergrond-loop. Sectie 10 beschrijft de **roadmap** om de AI
betekenisvoller te maken dan alleen "samenvatten achteraf".

> Veiligheidskader: de AI-laag levert **alleen observaties en vragen**. Nooit
> alarm- of actiebeslissingen. Past bij de reactieve-hypoglykemie use-case
> (geen insuline/closed-loop). Zie ook `README.md` en `hypo.md`.

## 0. Statusmatrix (kort)

| Onderdeel | Status | Opmerking |
|-----------|--------|-----------|
| AI-knop + paneel | Live/getest | Fase 1-4 staan hieronder als implementatiehistorie |
| Model-dropdown + Ollama-router | Live/getest | Cloud JSON-mode, geen schema-enforcement |
| Observaties/vragen opslaan | Live | `ai_observations` / `ai_questions` met runId/model/retentie |
| Detailweergave + runhistorie | Live | Gratis: alleen Mongo-reads |
| Rapportages A/B/C/D | Live | A/B deterministisch, C/D 1 LLM-call en opgeslagen in `ai_reports` |
| Chat | Plan | Nuttig, maar quota- en safety-gevoelig |
| Verdiepte hypo-analyse | Eerste slice gebouwd | Deterministische episode-metrics, severity, burden, recovery, rebound |
| CGM-datakwaliteit/artefacten | Eerste slice gebouwd | Quality flags/score voor datagaten, single-point lows, lag, mogelijke compression lows |
| SmartXdrip-achtige review-workflow | Deels gebouwd | Dagreview, high episodes, high->low context en heatmap live; History/detail nog open |
| Safety guardrails + evaluatie | Te bouwen | Vooral belangrijk voor chat en narratieve rapporten |

**Nieuwe prioriteit na online review (12 juni 2026):**
1. Verdiepte hypo-analyse + CGM-datakwaliteit (sectie 15/16).
2. Event-/maaltijdlogging uitbreiden (sectie 14, gekoppeld aan 15).
3. History + echte High/Low Episode detail-workflow (sectie 19).
4. Safety guardrails + evaluatie (sectie 17/18).
5. Pas daarna interactieve chat (sectie 13), omdat elk bericht quota kost en medisch
   gevoeliger is dan deterministische rapportage.

---

## 1. Huidige architectuur (vastgesteld in code)

```
browser overlay  ──HTTP /_*──►  nginx (1337/443)  ──proxy──►  libreview-sync:8787  ──►  MongoDB
(rate-overlay.js)               (app-locations.conf)          (libreview-nightscout-sync.mjs)
```

- **Overlay** = `nightscout-overlay/rate-overlay.js` (browser-script). Kan zelf géén
  Mongo/Ollama benaderen; praat uitsluitend via `/_`-endpoints.
  - Haalt al data via `/_prediction/latest`, `/_overlay/entries`, `POST /_feedback`.
  - Knoppenstack (calc / view / nav) wordt gepositioneerd in de layout-functie.
- **nginx** = `nightscout-overlay/app-locations.conf`: mapt `/_xxx` →
  `http://libreview-sync:8787/xxx`. Gemount read-only in de `nightscout-ui` service.
- **Server** = `scripts/libreview-nightscout-sync.mjs`, Docker-service `libreview-sync`,
  draait met `--server --loop` op poort 8787. Heeft al Mongo-toegang en routes
  (`/prediction/latest`, `/overlay/entries`, `/feedback`, `/sync`, `/health`).
- **AI-logica** = `scripts/ai-review.mjs` + `scripts/lib/ai-router.mjs`. Nu CLI-only
  (`npm run ai:review`). Router is multi-provider met fallback-volgorde; leest
  `.env.ai` (gitignored) via `node --env-file-if-exists`.

---

## 2. Online research — Ollama Cloud (juni 2026)

Bronnen onderaan. Relevante conclusies voor dit ontwerp:

1. **OpenAI-compatible endpoint werkt op cloud.** `POST https://ollama.com/v1/chat/completions`
   met `Authorization: Bearer <key>` geeft `choices[0].message.content` terug. Ondersteunde
   request-velden: `model`, `messages`, `temperature`, `top_p`, `max_tokens`, `stop`,
   `stream`, `response_format`, `tools`, `reasoning_effort`. (Getest: werkt.)
2. **`response_format: {type:"json_object"}` (JSON-mode) werkt** op cloud. (Getest: gaf
   geldige JSON terug met `gpt-oss:120b`.)
3. **Strikte structured outputs (JSON-schema via `format`) worden op Ollama Cloud
   NIET ondersteund.** Het native `/api/chat` `format`-veld met JSON-schema werkt alleen
   lokaal, niet op cloud. → We kunnen niet leunen op schema-enforcement.
4. **Best practices voor betrouwbare JSON** (geldt juist nu schema-enforcement ontbreekt):
   - `temperature` laag (0–0.2).
   - Expliciet in de prompt: "antwoord uitsluitend met JSON, geen extra tekst".
   - De gewenste structuur (schema) **als tekst in de prompt** meegeven om het model te gronden.
   - **Valideren** na parsen; bij parse-fout **opschonen of 1× retry**.
5. **Model-listing**: `GET https://ollama.com/api/tags` (native, Bearer) of
   `/v1/models` (OpenAI-compat). `/api/tags` is getest en geeft de cloud-modellen terug.

→ **Ontwerpkeuze:** blijf bij de bestaande OpenAI-compatible router + `json_object`
mode, en maak `ai-review-core` robuust met **validatie + één retry** bij ongeldige JSON.
Geen afhankelijkheid van cloud-schema-enforcement.

---

## 3. Productkeuzes (door gebruiker bevestigd)

| Vraag | Keuze |
|------|-------|
| Trigger | **Knop nu** + periodieke loop **alvast meebouwen** (default uit) |
| Model-keuze | **Dropdown** met alle modellen (uit `/api/tags`) |
| Resultaat | **Wegschrijven** naar Mongo (`ai_observations` / `ai_questions`) |

---

## 4. Doel-architectuur

```
overlay "AI"-knop ─► POST /_ai-review/run {model}  ─► server.runAiReview() ─► Ollama Cloud
                                                              │
                                                              └─► Mongo write (observations/questions)
overlay paneel    ─► GET  /_ai-review/latest        ─► server leest recente docs uit Mongo
model-dropdown    ─► GET  /_ai-review/models        ─► server proxyt Ollama /api/tags

(optioneel, default uit) server-loop elke AI_REVIEW_INTERVAL_MINUTES ─► dezelfde runAiReview()
```

---

## 5. Implementatie per fase

### Fase 1 — Backend (server + refactor)

**1.1 `scripts/lib/ai-review-core.mjs` (NIEUW)** — kernlogica losgetrokken uit
`ai-review.mjs` zodat CLI én server dezelfde code gebruiken.
- Exporteert `runAiReview({ db, dryRun, model, limit })` → `{ ok, provider, model,
  observations, questions, skipped?, reason? }`.
- Verplaatst hierheen: `readAiRouterConfig`-gebruik, `systemPrompt`, `userPrompt`,
  `callChat`, `cleanObservation`, `cleanQuestion`, `sourceName`, snapshot-projectie + query.
- **Robuustheid (research-punt 4):** als `JSON.parse` faalt → één retry met een extra
  system-instructie ("vorige output was geen geldige JSON; geef uitsluitend geldige
  JSON volgens dit schema: …"). Faalt het opnieuw → nette fout, niets wegschrijven.
- Schema-grounding: neem de gewenste JSON-structuur als tekst op in de system-prompt.
- `model` (optioneel) overschrijft het provider-model (zoals de huidige `--model` flag).
- Schrijft alleen weg als `dryRun` false is; geeft altijd het resultaat terug.

**1.2 `scripts/ai-review.mjs` (REFACTOR)** — wordt een dunne CLI-wrapper:
opent Mongo, leest `--dry-run` / `--force` / `--model`, roept `runAiReview()` aan,
print JSON. Gedrag voor de CLI blijft identiek.

**1.3 `scripts/libreview-nightscout-sync.mjs` (NIEUWE ROUTES + LOOP)**
- Import `runAiReview` en `readAiRouterConfig` uit de core.
- **In-memory lock + min-interval** (module-scope): `let aiReviewRunning = false` en
  `let lastAiReviewAt = 0`. Voorkomt dubbele/spam-runs vanaf de knop.
- Route `POST /ai-review/run`:
  - Body optioneel `{ model }`. CORS al aanwezig.
  - Als `aiReviewRunning` → `409 { ok:false, message:'Review draait al' }`.
  - Als `now - lastAiReviewAt < AI_REVIEW_MIN_INTERVAL_MS` (default 30s) → `429`.
  - Anders: lock, `runAiReview({ db, dryRun:false, model })`, unlock, resultaat terug.
- Route `GET /ai-review/latest`:
  - Leest laatste N (`?limit=`, default 10) uit `ai_observations` + `ai_questions`,
    gesorteerd op `createdAt` desc. Geeft `{ ok, observations, questions }`.
- Route `GET /ai-review/models`:
  - Proxyt `GET https://ollama.com/api/tags` met de Bearer-key uit de router-config
    (eerste Ollama-provider), geeft `{ ok, models:[{name}] }`. Korte cache (bv. 5 min)
    om Ollama niet te spammen.
- **Periodieke loop (alvast, default uit):** lees `AI_REVIEW_INTERVAL_MINUTES`
  (default `0`). Als `> 0`, start een `setInterval` die `runAiReview()` aanroept met
  dezelfde lock. Log resultaat. Zet later op bv. `60` om elk uur te draaien.

**1.4 Env / Docker**
- `AI_OLLAMA_*` (+ `AI_ROUTER_PROVIDERS=ollama`) moeten beschikbaar zijn in de
  `libreview-sync` container. Twee opties:
  - **A (aanbevolen):** voeg `.env.ai` toe aan de `env_file`-lijst van `libreview-sync`
    in `docker-compose.nightscout.yml`. `.env.ai` staat gitignored, dus per host plaatsen.
  - **B:** zet de vars onder `environment:` (komt dan wél in git — niet doen met de key).
- `node --env-file-if-exists` is alleen voor de CLI; de server leest gewoon `process.env`,
  dus de env moet via Docker `env_file` binnenkomen.

### Fase 2 — nginx (`nightscout-overlay/app-locations.conf`)

Drie `location`-blokken bij, in dezelfde stijl als de bestaande:

```nginx
location = /_ai-review/run {
  proxy_pass http://libreview-sync:8787/ai-review/run;
}
location = /_ai-review/latest {
  proxy_pass http://libreview-sync:8787/ai-review/latest$is_args$args;
}
location = /_ai-review/models {
  proxy_pass http://libreview-sync:8787/ai-review/models;
}
```

(`POST` doorlaten; bestaande blokken tonen het patroon. nginx herladen na wijziging.)

### Fase 3 — Overlay (`nightscout-overlay/rate-overlay.js`)

**3.1 "AI"-knop** toevoegen aan de bestaande knoppenstack (de verticale stack-logica
is recent toegevoegd; knop toevoegen aan de `stackButtons`-array + aanmaken zoals
`calcButton`/`viewButton`).

**3.2 AI-paneel** (nieuw DOM-element, vergelijkbaar met carb-advies-paneel):
- **Model-dropdown**: gevuld via `GET /_ai-review/models` (1× bij openen, gecachet).
  Default-selectie `gpt-oss:120b`. Keuze onthouden in `localStorage`.
- **"Review draaien"-knop**: `POST /_ai-review/run` met `{ model }`. Tijdens de call:
  knop disabled + spinner/"bezig…"; bij klaar: paneel verversen. Fouten (409/429/500)
  netjes tonen.
- **Weergave**: lijst van observaties (`summary`/`hypothesis`, `confidence`, `scope`)
  en vragen (`question`/`reason`). HTML escapen (er is al een `escapeHtml`).
- **Laden + verversen**: bij openen `GET /_ai-review/latest`; licht periodiek (bv. elke
  60s als het paneel open is) opnieuw, zodat achtergrond-loop-resultaten verschijnen.

**3.3 Styling**: stijl-regels bij de bestaande `#cgm-hypo-alert`-CSS-injectie, in lijn
met de huidige look (monospace, donkere tekst).

### Fase 4 — Verifiëren & deployen

1. **Lokaal**: server tegen Mongo draaien, endpoints testen:
   - `curl -XPOST localhost:8787/ai-review/run -d '{"model":"gpt-oss:120b"}'`
   - `curl localhost:8787/ai-review/latest`
   - `curl localhost:8787/ai-review/models`
2. **Overlay** in de browser: knop → paneel → run → resultaat zichtbaar; dropdown gevuld.
3. **iMac-deploy** (`192.168.178.240`, Docker, UI op 1337):
   - `.env.ai` op de host plaatsen (key erin) + aan `env_file` van `libreview-sync` koppelen.
   - `docker compose ... up -d --build libreview-sync` (herbouw server).
   - nginx-config herladen (`nightscout-ui` herstarten of `nginx -s reload`).
4. **Smoke-test** op de iMac via de UI.

---

## 6. Datamodel

`ai_observations`: `{ _id, createdAt (ISO-string), runId, model, source, scope,
relatedEventIds[], summary, hypothesis, confidence, needsUserConfirmation, acceptedByUser }`
`ai_questions`: `{ _id, createdAt, runId, model, source, question, reason,
relatedEntryIdentifier, relatedEntryId, relatedEventId, answeredAt, answer }`

- `source` = `ai-router:<provider>` (bv. `ai-router:ollama`).
- `runId` (UUID) groepeert alle docs van één review-run; `model` = gebruikt Ollama-model.
- **Indexen:** `{createdAt:-1}` en `{runId:1}` op beide collecties (idempotent aangemaakt).
- **Retentie:** docs ouder dan `AI_REVIEW_RETENTION_DAYS` (default 90) worden bij elke run
  geprund → zelf-schalend, geen onbegrensde groei.
- `/ai-review/latest` geeft alleen de **laatste run** (op `runId`) terug → geen duplicaten
  in het paneel.

**Status: GEDAAN** (runId/model/index/retentie + Nederlandstalige output zijn live).

---

## 7. Risico's & mitigaties

| Risico | Mitigatie |
|--------|-----------|
| LLM-call traag (sec) | Knop disabled + laad-state; ruime timeout (`AI_OLLAMA_TIMEOUT_MS=60000`) |
| Knop-spam / kosten | Server-lock + min-interval (30s) + 1 run tegelijk |
| Ongeldige JSON (geen cloud-schema) | JSON-mode + schema-in-prompt + validatie + 1× retry |
| Key-lek | `.env.ai` gitignored; nooit in `environment:` van compose; key roteerbaar |
| Provider down | Router-fallback-volgorde (meerdere providers mogelijk) |
| Overlay toont stale data | Periodiek `/_ai-review/latest` verversen als paneel open is |
| Onbegrensde DB-groei (loop) | Retentie-prune (`AI_REVIEW_RETENTION_DAYS`, default 90) + indexen op `createdAt`/`runId` |
| Extra LLM-kosten bij "inzien" | Detail/historie komen uit opgeslagen data (Mongo-reads), nooit een nieuwe Ollama-call (zie 11) |

---

## 8. Bestanden die wijzigen

| Bestand | Aard |
|---------|------|
| `scripts/lib/ai-review-core.mjs` | **nieuw** — gedeelde runAiReview + robuuste JSON |
| `scripts/ai-review.mjs` | refactor → dunne CLI-wrapper |
| `scripts/libreview-nightscout-sync.mjs` | 3 routes + lock + optionele loop |
| `nightscout-overlay/app-locations.conf` | 3 nginx-locations |
| `nightscout-overlay/rate-overlay.js` | AI-knop + paneel + dropdown + CSS |
| `docker-compose.nightscout.yml` | `.env.ai` aan `env_file` van libreview-sync |
| `.env.ai` (host, gitignored) | `AI_OLLAMA_*` op de iMac |
| `README.md` | korte sectie over de AI-knop + endpoints |

---

## 9. Volgorde van uitvoeren

1. Fase 1 (core-refactor + endpoints + lock) → endpoints los testbaar.
2. Fase 2 (nginx) → endpoints bereikbaar via `/_`.
3. Fase 3 (overlay UI) → knop + paneel + dropdown.
4. Fase 4 (deploy iMac) + periodieke loop later activeren via `AI_REVIEW_INTERVAL_MINUTES`.

---

## 10. Roadmap — betekenisvollere AI-rollen

Wat nu live is (samenvatten van recente snapshots) is de meest oppervlakkige rol.
De data ligt er al voor rijkere rollen: `prediction_snapshots`, `user_feedback`,
`episodes` / `episode_vectors`. **Harde grens blijft:** de AI neemt nooit
alarm-/actiebeslissingen over; de detector (V1/V2) blijft de veiligheidskritische
laag. De AI maakt de *gebruiker* slimmer over zijn patronen, niet de wiskunde.

### 10.1 Feedback-lus sluiten ⭐ (grootste winst, laag risico)
**Status: eerste slice GEDAAN.** De review laadt nu de laatste 20 `user_feedback`
(confirmed/false_alarm/feels_hypo/ate_now/fingerstick_confirmed) en stuurt die als
`recentUserFeedback` mee in de prompt; de system-prompt instrueert het model om
hypotheses hierop te verfijnen en geen vragen te stellen die de feedback al
beantwoordt. Geverifieerd: observaties refereren expliciet aan eerdere feedback.

Nog open (volgende slices):
- Antwoorden op specifieke `ai_questions` mogelijk maken in de UI en terugkoppelen
  (`ai_questions.answer` bestaat al als veld).
- Optioneel: gedestilleerde inzichten persisteren in een `ai_insights`-collectie zodat
  de context niet onbeperkt groeit.

### 10.2 Trigger- & patroonherkenning
In plaats van per-snapshot: analyseer de **hele historie** op terugkerende
dip-triggers (tijdstip, weekdag, daling-na-piek-curve, en — met feedback — welke
situaties echt tot een hypo leidden).
- Nieuwe aggregatie-input: episodes + outcome (`outcomeEvaluated`, `result`) i.p.v.
  losse snapshots.
- Output: observaties met `scope: 'week'`/`'day'` zoals "dips vooral op werkdagen
  11–12u, ~2u na lunch". Raakt direct het doel: **eerder zien aankomen**.

### 10.3 Live "waarom nu?"-uitleg
Een regel/knop die in gewone taal uitlegt waaróm de detector nú op `watch/high`
staat (rate, daling vanaf piek, gelijkende episodes). **Geen** alarmbesluit — alleen
de bestaande beslissing begrijpelijk maken. Kan via `/_ai-review/explain` met de
laatste snapshot; let op latency (cache per `entryIdentifier`).

### 10.4 Dag-/weekoverzicht (digest)
Periodieke digest (sluit aan op de al gebouwde loop): episodes, bijna-missers,
time-in-range, met hypotheses. Schrijf naar `ai_observations` met `scope:'day'`/`'week'`.

### 10.5 Detector-tuning adviseur (advies-only)
AI bekijkt waar V2 miste / vals alarm gaf en stelt **parameter-richtingen** voor die
de mens in `tune-reactive-hypo-v2.mjs` test. Nooit automatisch toepassen.

### Prioriteit
Aanbevolen volgorde: **10.1 → 10.2** (samen de meeste betekenis voor de
reactieve-hypo use-case), daarna 10.3/10.4. 10.5 los, indien gewenst.

### Aandachtspunten voor deze fases
- Ollama Cloud kan geen strikt JSON-schema afdwingen → blijf bij JSON-mode +
  prompt-grounding + validatie/retry (zie sectie 2).
- Contextgrootte bewaken: stuur samenvattingen/aggregaties, geen ruwe historie.
- Kosten/latency: zwaardere analyses (10.2/10.4) bij voorkeur via de periodieke loop,
  niet synchroon achter een knop.

---

## 11. Uitgebreide rapport-/detailweergave in het paneel

**Doel:** in het AI-paneel op een observatie of vraag klikken → het **volledige
detail ("rapport")** uitgebreid inzien (nu wordt alleen een afgekapte `summary` +
meta-regel getoond).

> **Gratis-tier kernprincipe (Ollama):** het detail bestaat volledig uit **al
> opgeslagen data** (de velden in `ai_observations`/`ai_questions` die al via
> `GET /_ai-review/latest` zijn opgehaald). Uitklappen/bladeren = **puur UI + Mongo-reads,
> nul extra LLM-calls, nul GPU-quota.** Géén enkele klik in de detailweergave mag Ollama
> aanroepen. Alleen "Review draaien" (en optioneel 11.3) raakt de quota.

### 11.1 Inline uitklap (minimaal — aanbevolen als eerste stap) — **GEDAAN (live)**
- Elk lijst-item (`.ai-item`) wordt klikbaar; klik toggelt een detail-blok eronder
  (accordion). Tweede klik klapt weer dicht.
- Detail toont **alle opgeslagen velden**, leesbaar en volledig (niet afgekapt):
  - **Observatie:** volledige `summary` + `hypothesis`, `confidence`, `scope`, `model`,
    tijdstip (`createdAt`), `needsUserConfirmation`; `runId` klein/grijs onderaan.
  - **Vraag:** volledige `question` + `reason`, gerelateerde entry
    (`relatedEntryIdentifier`), `model`, tijdstip; later een antwoord-veld (zie 10.1).
- **Geen nieuw endpoint nodig:** `/_ai-review/latest` levert de volledige docs al. De
  overlay bewaart de opgehaalde docs in geheugen (bv. `aiLatestData`), geeft items een
  `data-idx`, en de click-handler rendert het detail uit dat object. Alles via
  `escapeHtml`. **Free-tier safe.**
- Bestand: alleen `nightscout-overlay/rate-overlay.js` (`renderAiLatest` uitbreiden +
  click-to-expand + wat detail-CSS). Geen server-/nginx-wijziging.

### 11.2 Run-historie bladeren (optioneel — ook nul LLM-kost) — **GEDAAN (live)**
Nu toont het paneel alleen de laatste run. Om **oudere rapporten** in te zien:
- Nieuw endpoint `GET /ai-review/runs` → lijst van runs: distinct `runId` +
  `createdAt` + `model` + aantallen, nieuw→oud. **Alleen Mongo-reads.**
- Nieuw endpoint `GET /ai-review/run?id=<runId>` → alle obs/vragen van die run.
- Paneel: een run-selector (datum/tijd + model) bovenin; kies een run → toon die.
  Default blijft de laatste run.
- nginx: `/_ai-review/runs` + `/_ai-review/run` locations erbij (zelfde patroon).
- **Free-tier safe:** puur lees-queries op bestaande data; raakt Ollama niet.

### 11.3 (Optioneel — kost WÉL 1 LLM-call) "Uitgebreid rapport genereren"
Wil je een rijker, samenhangend verslag dan de losse observaties (≈ digest, 10.4):
- Eén knop "Uitgebreid dagrapport" die **één** extra review-achtige call doet met een
  digest-prompt (`scope: 'day'`), opgeslagen als gewone observatie.
- **Gratis-tier discipline:** user-getriggerd (nooit automatisch per klik), achter de
  bestaande lock + `AI_REVIEW_MIN_INTERVAL_MS`, en bij voorkeur via de periodieke loop
  **max 1×/dag** i.p.v. per klik. Duidelijk gescheiden van de gratis weergave (11.1/11.2).

### 11.4 Gratis-tier richtlijnen (samengevat)
- **Inzien = gratis:** detail uitklappen, run-historie bladeren, paneel verversen →
  uitsluitend Mongo-reads, nooit Ollama.
- **Genereren = quota:** alleen "Review draaien" en (optioneel) "Uitgebreid rapport"
  raken Ollama; hou die user-getriggerd + rate-limited.
- Free-tier = 1 model tegelijk, GPU-tijd-quota, 5-uurs/7-daagse limieten; sommige
  modellen geven 403 (abonnement). Daarom: zware/herhaalde analyses via de loop
  (max 1×/uur of /dag), niet per klik.

### Prioriteit / volgorde
**11.1 eerst** (klein, in één bestand, nul kosten, lost direct de wens op). Daarna
**11.2** als je oudere rapporten wilt bladeren. **11.3** alleen als losse observaties
echt te mager blijken — en dan strikt rate-limited i.v.m. de free-tier.

---

## 12. Rapportages (naast observaties/vragen)

**Doel:** naast losse observaties/vragen ook **echte rapporten** tonen, gebaseerd op de
klinische CGM-standaard (AGP) en op reactieve-hypo-onderzoek.

**Status: A + B + C/D GEDAAN (live).** Paneel heeft 3 tabs (Inzichten / Statistiek /
Rapporten). A (AGP-light) + B (episodes) zijn deterministisch/gratis; C/D (narratief
dagrapport) draait via `POST /ai-review/report` (1 LLM-call, achter de lock) en wordt
opgeslagen in `ai_reports`.

**Achtergrond (zie Bronnen):**
- **AGP (Ambulatory Glucose Profile)** is de standaard CGM-rapportage (ADA 2025):
  Time in Range (TIR, 3,9–10 mmol/L), Time Below/Above Range (TBR/TAR), gemiddelde
  glucose, variabiliteit (**CV%**, doel <36%), en een mediaan-curve per tijdstip van de
  dag. ~14 dagen data geeft een betrouwbaar beeld.
- **Reactieve hypo** (niet-diabetici): dips meestal **binnen 4u na eten**, daling begint
  **~30–40 min na de piek**; relevant zijn minimumwaarden en piek→dal per episode.

**Gratis-tier kernprincipe:** de **cijfers zijn deterministisch** (rechtstreeks uit
Mongo gerekend → **0 LLM-calls**). Alleen de *tekstuele duiding* (C/D) kost 1 call, en
draait bij voorkeur via de periodieke loop, niet per klik.

**Veiligheidsgrens:** rapporten zijn **beschrijvend** (cijfers + patronen), nooit een
medisch voorschrift. "Afvlakken van de piek" e.d. alleen als observatie, niet als advies.

### 12.1 A — Statistiek / AGP-light (deterministisch, gratis)
- **Berekend uit `entries`** (sgv → mmol /18.0182) over een venster (`?days=14`):
  TIR / TBR (<3,9; very-low <3,0) / TAR (>10; very-high >13,9), gemiddelde, SD, **CV%**,
  aantal low-episodes + langste low, en **per-uur profiel** (gemiddelde + %low per uur 0–23
  = AGP-light "wanneer dip ik"). Plus datadekking (% van verwachte metingen).
- **Endpoint:** `GET /ai-review/stats?days=14` → `{ ok, window, tir, tbr, tar, mean, cv,
  lows, perHour:[...] }`. **Geen LLM.** Live berekenen (single-user = goedkoop), evt. 5-min cache.
- **UI:** metric-kaartjes + een simpele per-uur balk/sparkline.

### 12.2 B — Reactieve-hypo episode-rapport (deterministisch, gratis)
- **Bron:** bestaande `reactive_hypo_episodes` (gebouwd door
  `scripts/build-reactive-hypo-episodes.mjs`). Verifieer de veldnamen bij het bouwen.
- **Toont:** lijst recente dips met piek→dal (mmol), **diepte**, **tijdstip**, **duur**,
  en minuten piek→nadir. Sorteer nieuw→oud.
- **Endpoint:** `GET /ai-review/episodes?limit=20` → `{ ok, episodes:[...] }`. **Geen LLM.**
- **UI:** compacte tabel; klikbaar voor detail (zoals 11.1).

### 12.3 C — Trigger / tijd-van-dag duiding (1 LLM-call, via loop)
- Neemt de aggregaten van A/B (+ `user_feedback`) en laat het model in **lopende tekst**
  duiden wanneer dips clusteren en welke triggers waarschijnlijk zijn ("dips vooral
  werkdagen 11–12u, ~2u na lunch"). Sluit aan op roadmap 10.2.
- **Eén** call, user-getriggerd of via de loop (max 1×/dag). Opgeslagen als rapport (zie 12.5).

### 12.4 D — Dagrapport (digest) (1 LLM-call/dag, via loop)
- Combineert A+B-cijfers + korte duiding tot één **samenhangend dagverslag**.
- Via de periodieke loop max **1×/dag**; opgeslagen als rapport. Sluit aan op roadmap 10.4.

### 12.5 Opslag van rapporten (C/D)
- Nieuwe collectie **`ai_reports`**: `{ _id, createdAt, runId, model, source, type:
  'trigger'|'daily'|'weekly', period:{from,to}, stats (snapshot van A), content (tekst) }`.
- Indexen `{createdAt:-1}` + `{type:1}`; zelfde retentie als observaties
  (`AI_REVIEW_RETENTION_DAYS`).
- A/B (12.1/12.2) hoeven **niet** opgeslagen — altijd live/deterministisch berekend.
- **Endpoint:** `GET /ai-review/reports?type=&limit=` → lees-only, geen LLM.

### 12.6 UI-structuur in het paneel
Drie tabs bovenin het AI-paneel (de panel-inhoud wordt anders te vol):
- **Inzichten** — huidige obs/vragen + run-selector (11.1/11.2, bestaand).
- **Statistiek** — A (metric-kaartjes) + B (episode-tabel), live/gratis.
- **Rapporten** — C/D narratieve verslagen (uit `ai_reports`), klikbaar detail.

### 12.7 Endpoints & nginx (samenvatting)
Nieuw (allemaal `/_ai-review/*` via nginx, zelfde patroon):
`GET /stats`, `GET /episodes`, `GET /reports` (gratis, lees-only) en het genereren van
C/D hangt aan de bestaande `runAiReviewOnce`-achtige flow (lock + min-interval).

### 12.8 Gratis-tier discipline (samengevat)
- **Bekijken/berekenen = gratis:** A, B, en het lezen van opgeslagen C/D-rapporten zijn
  puur Mongo (deterministisch) → nooit Ollama.
- **Genereren = quota:** alleen C/D (en "Review draaien") raken Ollama; user-getriggerd of
  max 1×/dag via de loop.

### Prioriteit / volgorde
**A + B eerst** (deterministisch, gratis, klinische standaard, directe waarde). Daarna de
UI-tabs (12.6). Daarna **C/D** (narratief, 1 call), gekoppeld aan de periodieke loop.

---

## 13. Interactieve chat (gevraagd) — plan

**Doel:** een chatvenster in het paneel waar je vragen kunt stellen ("waarom dipte ik
vanmorgen?", "wanneer ben ik het meest kwetsbaar?") en de AI antwoordt, **gegrond in je
eigen data** (stats, episodes, recente observaties/feedback).

> **Gratis-tier let op (belangrijk):** in tegenstelling tot bladeren/inzien kost **elk
> chatbericht 1 LLM-call** → het verbruikt Ollama-quota per bericht. Daarom: bewust en
> spaarzaam gebruiken; geen auto-polling; compacte context meesturen.

### 13.1 Server
- `POST /ai-review/chat` met `{ messages: [{role,content}...] }` (de client houdt de
  conversatie bij en stuurt 'm compact mee, bv. laatste ~10 berichten).
- Server bouwt: **system-prompt** (Nederlands; alleen over deze data; **geen medisch
  advies / geen alarmbeslissingen**) + een **compacte data-context** (samenvatting van de
  AGP-stats, top-N episodes, recente observaties/feedback) + de meegestuurde messages.
  Eén `callAiRouter`-call, antwoord terug als `{ ok, reply }`.
- **Lock:** hergebruik `aiReviewRunning` (1 call tegelijk = past bij free-tier 1-concurrent),
  maar **zonder** de 30s min-interval (anders is chatten onbruikbaar traag) — wel een
  korte guard tegen dubbele gelijktijdige calls.
- Optioneel: conversatie niet persisteren (privacy/eenvoud), of in `ai_chats` met retentie.

### 13.2 nginx
- `/_ai-review/chat` (POST, `proxy_read_timeout 120s`).

### 13.3 Overlay
- Vierde tab **Chat**: berichtenlijst + invoerveld + verstuurknop. Tijdens een call:
  invoer disabled + "AI denkt na…". Antwoord eronder. Bewaar de history in geheugen
  (evt. `localStorage`). Toon een kleine "kost quota"-hint.

### 13.4 Prioriteit
Bouwbaar als losse, contained feature (core `runAiChat` + 1 route + 1 nginx-locatie + tab).
Bewust ná de gratis features, omdat het quota kost per bericht.

---

## 14. Hoe de AI beter kan (research-gegrond)

Op basis van online onderzoek (zie Bronnen) — relevant voor reactieve hypoglykemie:

- **Maaltijd-/event-logging = grootste hefboom.** Reactieve hypo wordt gedreven door
  **wat en wanneer** je eet; nu ziet de AI alleen glucosecurves. Een snelle log
  (maaltijd/snack/symptoom + tijd, evt. grove samenstelling) — als uitbreiding van de
  bestaande `user_feedback` (heeft al `ate_now`) — laat de AI **dips aan maaltijden
  koppelen** (trigger-identificatie, precies jouw doel) en bekende context benoemen
  (eiwit/vet vóór koolhydraten = "preload" vertraagt de piek en dempt de rebound-dip;
  low-GI; frequente kleine maaltijden). **Beschrijvend, nooit als voorschrift.**
- **Richere review-context:** geef de AGP-stats + episodes ook mee aan de gewone
  observatie-review (nu vooral snapshots), zodat observaties op weekpatronen leunen.
- **Counterfactuals/voedingssuggesties** (uit de literatuur) bewust **niet** doen: te dicht
  op medisch advies; buiten de veiligheidsgrens.

**Veiligheidsgrens blijft:** de AI duidt en beschrijft; de V1/V2-detector blijft de enige
alarmbron, en er wordt geen medisch advies of voorschrift gegeven.

---

## 15. Verdiepte hypo-analyse (deterministisch, gratis)

**Status: eerste slice gebouwd.** `scripts/lib/episode-builder.mjs` schrijft episode
`version:3` met extra metrics; `GET /ai-review/episodes` geeft ze door; de overlay toont
ernst, burden, herstel, rebound en datakwaliteit in de Statistiek-tab. Nog open:
maaltijd-/eventkoppeling, echte Whipple-classificatie op basis van symptomen/herstel, en
episode-clustering.

**Doel:** van "er was een dip" naar een bruikbare episode-analyse:
**piek -> dalingssnelheid -> nadir -> duur onder grens -> herstel -> rebound -> context
-> betrouwbaarheid**. Dit moet deterministisch op de server gebeuren; de LLM mag daarna
alleen uitleg geven.

### 15.1 Episode-metrics
Breid `reactive_hypo_episodes` uit of voeg een afgeleide projectie toe met:
- `startAt`, `peakAt`, `nadirAt`, `recoveredAt`, `endAt`.
- `peakMmol`, `nadirMmol`, `peakToNadirDeltaMmol`, `peakToNadirMinutes`.
- `fallRateMmolPerMin` en optioneel `fallRateMmolPer15Min`.
- `timeBelow3_9Minutes` en `timeBelow3_0Minutes`.
- `areaBelow3_9` en `areaBelow3_0` (diepte x duur = hypo-burden).
- `recoveryMinutes` (nadir -> terug boven 3,9 mmol/L).
- `reboundHigh` / `reboundPeakMmol` / `reboundMinutesAfterRecovery`.
- `nightEpisode` en `timeOfDayBucket` (`night`, `morning`, `afternoon`, `evening`).

### 15.2 Ernst en patroonlabels
Voeg labels toe die UI en rapporten direct kunnen tonen:
- `severity`: `uncertain` | `mild` | `relevant` | `severe`.
- `shape`: `fast_drop`, `slow_drift`, `prolonged_low`, `rebound`, `isolated_point`.
- `postprandialCandidate`: true als de dip binnen 4 uur na een maaltijd/event valt.
- `minutesSinceMeal` zodra maaltijdlogging beschikbaar is.
- `similarEpisodeIds` of cluster-id op basis van tijdstip, piek->dal-vorm en context.

### 15.3 Whipple-triade als classificatie, niet als diagnose
Gebruik feedback/symptomen om episodes te classificeren:
- `symptomatic_confirmed`: lage CGM + klachten + herstel na eten/glucose.
- `asymptomatic_low`: lage CGM zonder bekende klachten.
- `symptoms_without_low`: klachten, maar geen lage CGM op dat moment.
- `uncertain`: te weinig feedback of slechte datakwaliteit.

Belangrijk: dit is **geen diagnose**. Het voorkomt juist dat de app elke CGM-dip als
"echte reactieve hypo" presenteert.

### 15.4 Endpoints/UI
- `GET /ai-review/episodes` blijft gratis, maar retourneert de uitgebreide metrics.
- Detailweergave toont per episode: ernst, datakwaliteit, mini-tijdlijn, herstel en
  context/feedback.
- Rapporten gebruiken deze metrics als input; LLM krijgt samenvattingen, geen ruwe
  volledige CGM-historie.

---

## 16. CGM-datakwaliteit en artefacten

**Status: eerste slice gebouwd.** Episodes krijgen `qualityFlags[]` en `qualityScore`
voor datagaten, `single_point_low`, `possible_compression_low` en `lag_sensitive`.
Nog open: sensor-warmup/stale uit brondata, fingerstick-disagreement en expliciete
datadekking-waarschuwingen per dag/week in rapporten.

**Doel:** expliciet maken wanneer een lage waarde waarschijnlijk betrouwbaar is en wanneer
voorzichtigheid nodig is. CGM meet interstitieel vocht, kan achterlopen op bloedglucose
en kan fout-lage waarden geven door druk op de sensor ("compression lows").

### 16.1 Quality flags per episode
Voeg per episode `qualityFlags[]` en `qualityScore` toe:
- `data_gap_before`, `data_gap_during`, `data_gap_after`.
- `single_point_low` (een losse lage waarde zonder omliggend patroon).
- `possible_compression_low` (vooral nacht + abrupte daling + snel herstel zonder rebound).
- `lag_sensitive` (zeer snelle daling/stijging; CGM kan achterlopen).
- `sensor_warmup_or_stale` als brondata dat aangeeft.
- `fingerstick_confirmed` / `fingerstick_disagreed` vanuit feedback.

### 16.2 Datadekking in rapporten
AGP-light moet naast TIR/TBR/TAR ook tonen:
- verwachte vs ontvangen metingen;
- langste datagat;
- percentage bruikbare data;
- waarschuwing als een dag/week te weinig dekking heeft voor stevige conclusies.

### 16.3 Presentatieregel
Rapporten en chat mogen bij slechte datakwaliteit niet stellig formuleren. Voorbeelden:
- Wel: "Deze dip lijkt op een korte sensor-low; bevestiging ontbreekt."
- Niet: "Je had een reactieve hypo."

---

## 17. Safety guardrails voor chat en rapporten — plan

**Doel:** AI-antwoorden nuttig houden zonder medische besluitvorming te worden.
Recente LLM-health literatuur blijft laten zien dat modellen kunnen hallucineren,
te stellig antwoorden en gevoelig zijn voor promptvariaties. Daarom moet elke
patient-facing AI-route expliciete guardrails hebben.

### 17.1 Output-contract
Voor narratieve rapporten en chat gebruikt de server intern een gestructureerd contract:

```json
{
  "answer": "korte Nederlandse uitleg",
  "evidence": ["welke stats/episodes/feedback gebruikt zijn"],
  "uncertainty": "wat onbekend of onzeker is",
  "dataQuality": "goed|matig|slecht",
  "safetyLevel": "ok|caution|refer",
  "notMedicalAdvice": true
}
```

De UI mag dit als tekst tonen, maar de server valideert minimaal dat `answer`,
`uncertainty`, `dataQuality` en `safetyLevel` aanwezig zijn.

### 17.2 Chatregels
- Antwoord alleen op basis van eigen CGM-data, episodes, stats, rapporten en feedback.
- Geen diagnose, geen medicatieadvies, geen behandelvoorschrift.
- Bij vragen over ernstige symptomen, flauwvallen, aanhoudende hypo of medische keuzes:
  `safetyLevel:'refer'` en verwijs naar arts/spoedhulp.
- Benoem onzekerheid expliciet, vooral bij slechte datakwaliteit of ontbrekende feedback.
- Geen automatische vervolgacties; chat mag nooit detectorparameters wijzigen.

### 17.3 Auditability
Sla bij LLM-gegenereerde rapporten minimaal op:
- gebruikte periode;
- model/provider;
- compacte `contextSnapshot` met stats/episode-ids/feedback-ids;
- promptversie;
- output-contract.

Voor chat: standaard **niet persisteren**. Als chat later wel wordt opgeslagen, dan alleen
met korte retentie en dezelfde `contextSnapshot`-aanpak.

---

## 18. Evaluatie: werkt dit echt beter? — plan

**Doel:** meten of de AI- en hypo-laag daadwerkelijk nuttiger wordt, zonder alleen op
mooie tekst te vertrouwen.

### 18.1 Deterministische metrics
Meet over 7/14/30 dagen:
- aantal hypo-episodes per severity;
- totale `areaBelow3_9` en `areaBelow3_0`;
- mediane recovery-tijd;
- percentage episodes met feedback;
- percentage episodes met `fingerstick_confirmed`;
- percentage episodes met slechte datakwaliteit;
- verdeling per uur/weekday en postprandiaal venster.

### 18.2 Detectorfeedback
Koppel aan bestaande feedback:
- confirmed vs false_alarm;
- feels_hypo zonder detector-alert;
- gemiste episodes achteraf;
- welke shape/severity geeft de meeste false positives.

### 18.3 AI-kwaliteit
Voor AI-observaties/rapporten:
- werd de observatie bevestigd of genegeerd?
- stelde de AI vragen die al beantwoord waren?
- bevatte het antwoord medische voorschriften? Zo ja: bug.
- gebruikte het antwoord evidence uit stats/episodes in plaats van losse speculatie?

### 18.4 Succescriterium
De volgende stap is pas geslaagd als:
- rapporten minder stellig worden bij slechte datakwaliteit;
- episodes beter geordend zijn op ernst/burden;
- gebruiker sneller ziet welke dips echt belangrijk zijn;
- chat geen extra alarm- of behandelbeslissingen introduceert.

---

## 19. SmartXdrip-achtige review-workflow — plan

**Status: eerste slice gebouwd.** Geinspireerd door SmartXdrip Community Preview:
companion review naast Nightscout/xDrip, met Home/Insights/History/High Episode/Low
Episode/Stats. In deze repo is al live: `GET /ai-review/day`, dagcards in de
Statistiek-tab, high episodes, high->low context, source health en weekdag×uur heatmap.
Nog open: echte **History-tab**, aparte **High/Low Episode detailweergave** met
omliggende curve, en pattern cards in de Inzichten-tab.

### 19.1 Wat SmartXdrip toevoegt boven "stats"
De sterke productkeuze is niet alleen meer metrics, maar een review-flow:

1. **Home / insight banner:** "wat moet ik nu merken?" met actuele status en sync health.
2. **Insights:** daily brief, weekly review en pattern cards in gewone taal.
3. **History:** dag-voor-dag review met high/low event markers.
4. **Low Episode:** start, duur, nadir, herstelcontext, omliggende curve, waarom opvallend.
5. **High Episode:** start, duur, piek, herstelcontext, omliggende curve, waarom opvallend.
6. **Stats:** TIR, gemiddelde, CV/SD, range breakdown, AGP en heatmap.

Onze richting: dezelfde workflow, maar **deterministisch en local-first** waar mogelijk;
LLM alleen voor narratieve samenvatting nadat cijfers/episodes al vaststaan.

### 19.2 History-tab (volgende bouwstap)
Nieuwe tab in het AI-paneel: **History**.

Server:
- `GET /ai-review/history?days=14`
  - retourneert lijst dagen nieuw->oud;
  - per dag: `date`, TIR/TBR/TAR, gemiddelde, CV, min/max, coverage, low/high counts,
    hypo-burden, worst low, worst high, source-health.
- Hergebruik `getAiDayReview(date)` intern zodat logica niet dupliceert.

Overlay:
- Datumlijst/dagcards: "Vr 12 jun — TIR 94%, laag 3.2%, 2 lows, 1 high".
- Klik dag -> laadt `GET /_ai-review/day?date=YYYY-MM-DD`.
- Toon dagkaart met high/low event markers en links naar episode-detail.

Waarde:
- Dit maakt moeilijke dagen vindbaar zonder door ruwe Nightscout-curves te scrollen.
- Past direct bij SmartXdrip "History -> High/Low Episode".

### 19.3 Low Episode detail
Doel: niet alleen een rij in Statistiek, maar een echte detailkaart voor één low.

Server:
- `GET /ai-review/episode-detail?type=low&peakAt=<iso>`
- Zoek episode in `reactive_hypo_episodes`.
- Haal omliggende readings uit `entries`: standaard `peakAt - 2h` t/m `recoveredAt + 2h`
  of `nadirAt + 2h` als recovery ontbreekt.
- Retourneer:
  - episode metrics: piek, nadir, duur, burden, recovery, rebound, severity, shape;
  - quality flags/score;
  - surrounding readings `{t, mmol}`;
  - nearby high episodes en user feedback in hetzelfde venster;
  - `notableReasons[]`, deterministisch opgebouwd.

Notable reasons voorbeelden:
- "Diepe low: nadir <3.0."
- "Lang onder 3.9: >20 minuten."
- "Hoge piek vooraf gevolgd door snelle daling."
- "Mogelijke sensorartefact: single-point low / compression-low flag."
- "Herstel traag: >30 minuten."
- "Rebound high na herstel."

Overlay:
- Episode-rij klik -> detail uitklappen of modal binnen paneel.
- Mini-curve als simpele SVG/polyline of compacte tabel/sparkline.
- Toon "review, geen behandeladvies" subtiel onderaan.

### 19.4 High Episode detail
Highs zijn relevant omdat reactieve dips vaak beginnen na een hoge postprandiale piek.

Server:
- Maak high-episodes first-class:
  - optie A: live detecteren uit `entries` per dag/window;
  - optie B: persistente `glucose_high_episodes` builder als dit vaker nodig wordt.
- Metrics:
  - `startAt`, `endAt`, `peakAt`, `peakMmol`;
  - `durationAbove10Minutes`, `durationAbove13_9Minutes`;
  - `areaAbove10`, `areaAbove13_9`;
  - recovery naar <10;
  - opvolgende low binnen 4 uur (`followedByLowEpisodeId` / `minutesToLowPeak`).

Overlay:
- High episode detail toont piek, duur, area-above-threshold, herstel en eventuele
  high->low koppeling.
- Gebruik andere kleur/label dan low, maar zelfde review-structuur.

### 19.5 Pattern cards in Inzichten
Maak de eerste tab minder "losse AI-output" en meer SmartXdrip Insights.

Deterministische cards, gratis:
- **Vandaag:** korte banner uit `GET /day`.
- **Deze week vs vorige week:** TIR/TBR/TAR delta, low-burden delta.
- **Kwetsbaar venster:** hoogste low% of meeste low episodes per uur/weekdag.
- **High->low patroon:** aantal gekoppelde high->low gebeurtenissen.
- **Datakwaliteit:** coverage en langste datagat.
- **Artefact-check:** aantal `single_point_low` / `possible_compression_low`.

LLM-optie:
- De LLM mag deze cards samenvatten, maar alleen op basis van de card-data.
- Geen LLM nodig om de cards te detecteren.

### 19.6 Source health als first-class inzicht
SmartXdrip zet sync status/source health op Home. In onze overlay moet dit zichtbaar zijn:
- laatste meting;
- leeftijd laatste meting;
- coverage vandaag/14d;
- langste datagat;
- status: `goed` / `matig` / `slecht`.

Regel: als source health slecht is, moeten Inzichten/Rapporten expliciet minder stellig zijn.

### 19.7 Prioriteit
Aanbevolen volgorde:
1. `episode-detail` endpoint + low detail UI (meeste waarde, data bestaat al).
2. High episode metrics uitbreiden met area-above/recovery/followed-by-low.
3. History-tab met dagcards en datumselectie.
4. Pattern cards op Inzichten-tab.
5. Optioneel: persistente high-episode builder als live detectie te traag/onhandig wordt.

---

## Bronnen

- [OpenAI compatibility — Ollama docs](https://docs.ollama.com/api/openai-compatibility)
- [Structured outputs — Ollama docs](https://docs.ollama.com/capabilities/structured-outputs)
- [Structured outputs — Ollama blog](https://ollama.com/blog/structured-outputs)
- [OpenAI compatibility — Ollama blog](https://ollama.com/blog/openai-compatibility)
- [Clinical Targets for CGM / Time in Range — ADA consensus (Diabetes Care)](https://diabetesjournals.org/care/article/42/8/1593/36184/Clinical-Targets-for-Continuous-Glucose-Monitoring)
- [Time in Range in the 2025 ADA Standards of Care](https://www.timeinrange.org/time-in-range-in-the-2025-ada-standards-of-care/)
- [AGP report — uitleg (DiaTribe)](https://diatribe.org/diabetes-technology/making-most-cgm-uncover-magic-your-ambulatory-glucose-profile)
- [CGM voor reactieve hypoglykemie bij niet-diabetici (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC6232734/)
- [Postprandiale glykemische respons bij personen zonder diabetes (Metabolism)](https://www.metabolismjournal.com/article/S0026-0495(23)00244-5/fulltext)
- [Dieetstrategieën reactieve hypoglykemie / maaltijdsamenstelling (Wikipedia overzicht)](https://en.wikipedia.org/wiki/Reactive_hypoglycemia)
- [Nutriënt-volgorde (protein/fat preload) en glucosetolerantie (PMC)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6418004/)
- [LLM als "personal nutritionist" / gedrag↔glucose (Sensors, MDPI)](https://www.mdpi.com/1424-8220/25/17/5372)
- [CGM-beperkingen: interstitieel lag, fingerstick-confirmatie, compression lows](https://en.wikipedia.org/wiki/Continuous_glucose_monitor)
- [Blood glucose monitoring — CGM meet interstitieel vocht en loopt achter](https://en.wikipedia.org/wiki/Blood_glucose_monitoring)
- [Whipple-triade — symptomen + lage glucose + herstel](https://en.wikipedia.org/wiki/Whipple%27s_triad)
- [CareGuardAI — guardrails voor patient-facing medische LLMs](https://arxiv.org/abs/2604.26959)
- [When Large Language Models Fail in Healthcare — promptgevoeligheid/risico](https://arxiv.org/abs/2606.07237)
- [SmartXdrip Community Preview — companion review app](https://github.com/solgosea/smartxdrip-community-preview)
- [SmartXdrip Docs — Home / Insights / History / Episode / Stats workflow](https://solgosea.github.io/smartxdrip-docs/)
