import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
  Cell,
} from 'recharts'
import type { GlucoseReading } from '../types'
import { getGlucoseStatus } from '../types'

interface Props {
  readings: GlucoseReading[]
  unit?: 'mmol' | 'mgdl'
}

const STATUS_COLORS: Record<string, string> = {
  very_low: '#ff4444',
  low: '#f85149',
  normal: '#3fb950',
  high: '#d29922',
  very_high: '#ff9f0a',
}

function toDisplay(mmol: number, unit: 'mmol' | 'mgdl') {
  return unit === 'mgdl' ? Math.round(mmol * 18.0182) : mmol
}

// AR2 prediction: simple linear extrapolation over last 3 points
function predictPoints(readings: GlucoseReading[], unit: 'mmol' | 'mgdl'): { time: number; pred: number }[] {
  if (readings.length < 2) return []
  const last = readings.slice(-3)
  const n = last.length
  // Linear regression slope
  const times = last.map(r => new Date(r.timestamp).getTime())
  const vals = last.map(r => toDisplay(r.value_mmol, unit))
  const tMean = times.reduce((a, b) => a + b, 0) / n
  const vMean = vals.reduce((a, b) => a + b, 0) / n
  const slope = times.reduce((acc, t, i) => acc + (t - tMean) * (vals[i] - vMean), 0) /
    times.reduce((acc, t) => acc + (t - tMean) ** 2, 0)

  const lastTime = times[n - 1]
  const lastVal = vals[n - 1]
  const pts = []
  for (let i = 1; i <= 4; i++) {
    const t = lastTime + i * 5 * 60_000
    const v = lastVal + slope * (i * 5 * 60_000)
    pts.push({ time: t, pred: parseFloat(v.toFixed(unit === 'mgdl' ? 0 : 1)) })
  }
  return pts
}

export default function NightscoutChart({ readings, unit = 'mmol' }: Props) {
  const data = readings.map(r => ({
    time: new Date(r.timestamp).getTime(),
    value: toDisplay(r.value_mmol, unit),
    status: getGlucoseStatus(r.value_mmol),
  }))

  const predData = predictPoints(readings, unit)

  const timeMin = data[0]?.time ?? Date.now()
  const timeMax = predData.length
    ? predData[predData.length - 1].time
    : data[data.length - 1]?.time ?? Date.now()

  const low = unit === 'mgdl' ? 70 : 3.9
  const high = unit === 'mgdl' ? 180 : 10.0
  const yMin = unit === 'mgdl' ? 40 : 2
  const yMax = unit === 'mgdl' ? 320 : 18

  // Merge for ComposedChart — scatter needs own data
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart margin={{ top: 8, right: 20, bottom: 4, left: -8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#21262d" vertical={false} />

        <ReferenceArea y1={low} y2={high} fill="#3fb950" fillOpacity={0.06} ifOverflow="hidden" />

        <XAxis
          dataKey="time"
          type="number"
          domain={[timeMin, timeMax]}
          tickFormatter={formatTick}
          tick={{ fontSize: 11, fill: '#484f58' }}
          tickLine={false}
          axisLine={{ stroke: '#21262d' }}
          scale="time"
          interval="preserveStartEnd"
        />
        <YAxis
          domain={[yMin, yMax]}
          tick={{ fontSize: 11, fill: '#484f58' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={v => `${v}`}
        />

        <Tooltip
          cursor={{ stroke: '#30363d', strokeDasharray: '4 4' }}
          content={<CustomTooltip unit={unit} />}
        />

        <ReferenceLine y={low} stroke="#f85149" strokeDasharray="4 4" strokeWidth={1} opacity={0.6} />
        <ReferenceLine y={high} stroke="#d29922" strokeDasharray="4 4" strokeWidth={1} opacity={0.6} />

        {/* Connecting line */}
        <Line
          data={data}
          dataKey="value"
          type="monotone"
          stroke="#3fb950"
          strokeWidth={1.5}
          dot={false}
          activeDot={false}
          isAnimationActive={false}
          legendType="none"
        />

        {/* Colored dots */}
        <Scatter data={data} isAnimationActive={false}>
          {data.map((entry, i) => (
            <Cell key={i} fill={STATUS_COLORS[entry.status]} opacity={0.9} r={3} />
          ))}
        </Scatter>

        {/* AR2 prediction dots */}
        <Scatter data={predData.map(p => ({ time: p.time, value: p.pred, status: 'pred' }))} isAnimationActive={false}>
          {predData.map((_, i) => (
            <Cell key={i} fill="#8b949e" opacity={0.5} r={3} />
          ))}
        </Scatter>
      </ComposedChart>
    </ResponsiveContainer>
  )
}

function formatTick(ts: number) {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function CustomTooltip({ active, payload, unit }: {
  active?: boolean
  payload?: Array<{ payload: { time: number; value: number; status: string } }>
  unit?: 'mmol' | 'mgdl'
}) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  const color = d.status === 'pred' ? '#8b949e' : STATUS_COLORS[d.status]
  const label = unit === 'mgdl' ? `${d.value} mg/dL` : `${d.value.toFixed(1)} mmol/L`
  return (
    <div style={{
      background: '#161b22',
      border: '1px solid #30363d',
      borderRadius: 6,
      padding: '8px 12px',
      fontSize: 12,
      color: '#e6edf3',
      lineHeight: 1.6,
    }}>
      <div style={{ color, fontWeight: 600, fontSize: 15 }}>
        {d.status === 'pred' ? `~ ${label}` : label}
      </div>
      <div style={{ color: '#8b949e' }}>{formatTick(d.time)}{d.status === 'pred' ? ' (voorspelling)' : ''}</div>
    </div>
  )
}
