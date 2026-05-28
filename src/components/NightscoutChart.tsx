import {
  ResponsiveContainer,
  ScatterChart,
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
}

const STATUS_COLORS: Record<string, string> = {
  very_low: '#ff4444',
  low: '#f85149',
  normal: '#3fb950',
  high: '#d29922',
  very_high: '#ff9f0a',
}

export default function NightscoutChart({ readings }: Props) {
  const data = readings.map(r => ({
    time: new Date(r.timestamp).getTime(),
    value: r.value_mmol,
    status: getGlucoseStatus(r.value_mmol),
  }))

  const timeMin = data[0]?.time ?? Date.now()
  const timeMax = data[data.length - 1]?.time ?? Date.now()

  return (
    <ResponsiveContainer width="100%" height={260}>
      <ScatterChart margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#21262d" vertical={false} />

        {/* In-range background band */}
        <ReferenceArea y1={3.9} y2={10.0} fill="#3fb950" fillOpacity={0.06} ifOverflow="hidden" />

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
          dataKey="value"
          domain={[2, 18]}
          tick={{ fontSize: 11, fill: '#484f58' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={v => `${v}`}
        />

        <Tooltip
          cursor={{ stroke: '#30363d', strokeDasharray: '4 4' }}
          content={<CustomTooltip />}
        />

        <ReferenceLine y={3.9} stroke="#f85149" strokeDasharray="4 4" strokeWidth={1} opacity={0.6} />
        <ReferenceLine y={10.0} stroke="#d29922" strokeDasharray="4 4" strokeWidth={1} opacity={0.6} />

        <Scatter data={data} isAnimationActive={false}>
          {data.map((entry, i) => (
            <Cell key={i} fill={STATUS_COLORS[entry.status]} opacity={0.9} />
          ))}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  )
}

function formatTick(ts: number) {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: { time: number; value: number; status: string } }> }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  const color = STATUS_COLORS[d.status]
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
      <div style={{ color, fontWeight: 600, fontSize: 15 }}>{d.value.toFixed(1)} mmol/L</div>
      <div style={{ color: '#8b949e' }}>{formatTick(d.time)}</div>
    </div>
  )
}
