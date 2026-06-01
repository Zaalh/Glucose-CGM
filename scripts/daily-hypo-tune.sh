#!/usr/bin/env bash
# Dagelijkse auto-tune + dag/week-rapport van de V2 reactieve-hypo detector.
#
# Leert elke dag van JOUW recente episodes (de tuner schrijft geleerde params naar
# reactive-hypo-v2-state.json, die de live sync in shadow toepast) en schrijft een
# dag- en weekrapport. Verandert het live ALARM niet — dat blijft V1 tot M6.
#
# Geinstalleerd via launchd: deploy/com.glucosecgm.hypotune.plist
# Handmatig draaien:  bash scripts/daily-hypo-tune.sh

set -uo pipefail

REPO="${HYPO_REPO:-/Users/zaa/Documents/Glucose CGM}"
DOCKER="${DOCKER_BIN:-/usr/local/bin/docker}"
LOGDIR="$REPO/hypo-tune-reports"
STAMP="$(date +%Y-%m-%d)"

cd "$REPO" || { echo "repo niet gevonden: $REPO"; exit 1; }
mkdir -p "$LOGDIR"

COMPOSE=("$DOCKER" compose -f docker-compose.nightscout.yml --profile libre run --rm -T libreview-sync node)
ERR="$LOGDIR/${STAMP}.err.log"

echo "[$(date '+%F %T')] auto-tune + rapport start"

# 0) episodes verversen zodat de patroon-analyse de laatste dagen meeneemt
"${COMPOSE[@]}" scripts/build-reactive-hypo-episodes.mjs >"$LOGDIR/${STAMP}.episodes.log" 2>>"$ERR"

# 1) leren: tuner schrijft geleerde params (of niets bij te weinig events)
"${COMPOSE[@]}" scripts/tune-reactive-hypo-v2.mjs   >"$LOGDIR/${STAMP}.tune.log"  2>>"$ERR"
cp "$LOGDIR/${STAMP}.tune.log" "$LOGDIR/latest.tune.log" 2>/dev/null || true

# 2) dagrapport
"${COMPOSE[@]}" scripts/hypo-report.mjs --days 1    >"$LOGDIR/${STAMP}.day.json"  2>>"$ERR"
cp "$LOGDIR/${STAMP}.day.json" "$LOGDIR/latest.day.json" 2>/dev/null || true

# 3) weekrapport (laatste 7 dagen samengevat)
"${COMPOSE[@]}" scripts/hypo-report.mjs --days 7    >"$LOGDIR/${STAMP}.week.json" 2>>"$ERR"
cp "$LOGDIR/${STAMP}.week.json" "$LOGDIR/latest.week.json" 2>/dev/null || true

# 4) per-weekdag profiel (laatste 28 dagen): welke weekdagen zijn riskanter
"${COMPOSE[@]}" scripts/hypo-report.mjs --by-weekday --days 28 >"$LOGDIR/${STAMP}.weekday.json" 2>>"$ERR"
cp "$LOGDIR/${STAMP}.weekday.json" "$LOGDIR/latest.weekday.json" 2>/dev/null || true

# 5) patroon-ontdekking (uur-van-de-dag + weekdag + episode-statistiek, 28 dagen)
"${COMPOSE[@]}" scripts/hypo-patterns.mjs --days 28 >"$LOGDIR/${STAMP}.patterns.json" 2>>"$ERR"
cp "$LOGDIR/${STAMP}.patterns.json" "$LOGDIR/latest.patterns.json" 2>/dev/null || true

echo "=== samenvatting $STAMP ==="
grep -hE "trainHypoOnsets|testHypoOnsets|state geschreven|WAARSCHUWING" "$LOGDIR/${STAMP}.tune.log" 2>/dev/null | tail -4 || true
echo "rapporten: $LOGDIR/${STAMP}.{tune.log,day.json,week.json}"
echo "[$(date '+%F %T')] klaar"
