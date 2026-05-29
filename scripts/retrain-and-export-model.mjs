import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}

const compose = 'docker compose -f docker-compose.nightscout.yml'

run(`${compose} exec -T nightscout-mongo sh -lc 'mongo nightscout --quiet' < scripts/train-risk-model.mjs`)

const raw = run(`${compose} exec -T nightscout-mongo mongo nightscout --quiet --eval 'JSON.stringify(db.model_state.find({active:true}).sort({updatedAt:-1}).limit(1).toArray()[0] || null)'`)
const model = JSON.parse(raw.trim().split('\n').pop() || 'null')

if (!model) throw new Error('No active model_state found')

const out = {
  modelVersion: model.modelVersion,
  updatedAt: model.updatedAt,
  thresholds: model.thresholds,
  calibration: model.calibration,
  metrics: model.metrics,
}

writeFileSync('src/lib/risk-model-state.json', JSON.stringify(out, null, 2) + '\n', 'utf8')
console.log(`Exported ${out.modelVersion} to src/lib/risk-model-state.json`)
