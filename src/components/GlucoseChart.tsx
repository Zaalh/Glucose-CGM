import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from 'recharts'
import type { GlucoseReading } from '../types'

interface Props {
  readings: GlucoseReading[]
}

export default function GlucoseChart({ readings }: Props) {
  const data = readings.map(r => ({
    time: formatTime(r.timestamp),
    value: r.value_mmol,
  }))

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 4, right: 16, bottom: 0, left: -8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e9ecef" vertical={false} />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 11, fill: '#adb5bd' }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          domain={[2, 16]}
          tick={{ fontSize: 11, fill: '#adb5bd' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={v => `${v}`}
        />
        <Tooltip
          contentStyle={{
            background: '#fff',
            border: '1px solid #e9ecef',
            borderRadius: 8,
            fontSize: 13,
            padding: '8px 12px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
          }}
          formatter={(value: number) => [`${value.toFixed(1)} mmol/L`, 'Glucose']}
          labelStyle={{ color: '#6c757d', fontWeight: 500 }}
        />
        <ReferenceLine y={3.9} stroke="#c92a2a" strokeDasharray="4 4" strokeWidth={1.5} />
        <ReferenceLine y={10.0} stroke="#e67700" strokeDasharray="4 4" strokeWidth={1.5} />
        <Line
          type="monotone"
          dataKey="value"
          stroke="#1971c2"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, strokeWidth: 0, fill: '#1971c2' }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

function formatTime(timestamp: string) {
  const d = new Date(timestamp)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}
