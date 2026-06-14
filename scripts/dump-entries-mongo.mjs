// Dumpt de live Nightscout `entries` (sgv) naar een cgm_entries.json-compatibel JSON-array op stdout,
// zodat `scripts/export-gemini-cgm.mjs` er een high-res (1-min) Gemini-export van kan maken.
//
// Dit is een mongo-SHELL script (geen Node), net als scripts/live-snapshot-from-latest.mjs. Het draait
// IN de Docker-container omdat mongo geen host-poort exposed. Op de iMac:
//
//   docker compose -f docker-compose.nightscout.yml exec -T nightscout-mongo \
//     mongo nightscout --quiet < scripts/dump-entries-mongo.mjs > exports/live-entries.json
//   node scripts/export-gemini-cgm.mjs exports/live-entries.json exports/gemini-cgm-live
//
// Lookback past via een eval-prefix vóór de pipe, bijv. alleen de laatste 7 dagen:
//   ... mongo nightscout --quiet --eval 'var LOOKBACK_DAYS=7' ...   (eval+stdin combineert niet in de
//   legacy shell; pas dan onderstaande default aan of gebruik npm run dump:entries).

var LOOKBACK_DAYS = typeof LOOKBACK_DAYS !== 'undefined' ? LOOKBACK_DAYS : 21
var sinceMs = LOOKBACK_DAYS > 0 ? Date.now() - LOOKBACK_DAYS * 86400000 : 0

// Hele chain op één regel: de legacy mongo-shell verwerkt gepipete stdin regel-voor-regel,
// dus een chain die op een nieuwe regel met `.` begint breekt ("expected expression, got '.'").
var proj = { _id: 0, type: 1, sgv: 1, date: 1, dateString: 1, direction: 1, device: 1, identifier: 1 }
var rows = db.entries.find({ type: 'sgv', date: { $gte: sinceMs } }, proj).sort({ date: 1 }).toArray()

print(JSON.stringify(rows))
