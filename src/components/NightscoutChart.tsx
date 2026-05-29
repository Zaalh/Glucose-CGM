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
  predictedIn20?: number | null
  onSelectTimestamp?: (timestampMs: number) => void
}

const STATUS_COLORS: Record<string, string> = {
  very_low: '#ff4444',
  low: '#f85149',
  normal: '#3fb950',
  high: '#d29922',
  very_high: '#ff9f0a',
}

const ESTIMATED_LINE_COLOR = '#58a6ff'
const MIN_GAP_MS = 2.5 * 60_000
const MAX_OPEN_ESTIMATE_MS = 20 * 60_000

function toDisplay(mmol: number, unit: 'mmol' | 'mgdl') {
  return unit === 'mgdl' ? Math.round(mmol * 18.0182) : mmol
}

function predColor(mmol: number, low: number, high: number): string {
  const v = mmol
  if (v < 3.0) return '#ff4444'
  if (v < low)  return '#f85149'
  if (v > 13.9) return '#ff9f0a'
  if (v > high) return '#d29922'
  return '#3fb950'
}

export default function NightscoutChart({ readings, unit = 'mmol', predictedIn20 = null, onSelectTimestamp }: Props) {
  const data = readings.map((r, index) => {
    const time = new Date(r.timestamp).getTime()
    const prev = index > 0 ? readings[index - 1] : null
    const prevTime = prev ? new Date(prev.timestamp).getTime() : null
    const ratePerMin = prev && prevTime !== null && time > prevTime
      ? (r.value_mmol - prev.value_mmol) / ((time - prevTime) / 60000)
      : null

    return {
      time,
      value: toDisplay(r.value_mmol, unit),
      mmol: r.value_mmol,
      status: getGlucoseStatus(r.value_mmol),
      ratePerMin,
    }
  })
  const { actualSegments, estimatedSegments } = buildLineSegments(data, unit)

  const low  = unit === 'mgdl' ? 70  : 3.9
  const high = unit === 'mgdl' ? 180 : 10.0
  const yMin = unit === 'mgdl' ? 40  : 2
  const yMax = unit === 'mgdl' ? 320 : 18

  // Build prediction line: bridge from last real reading → 20-min forecast
  // One point per minute for a smooth curve
  const predLineData: { time: number; pred: number; predMmol: number }[] = []
  if (predictedIn20 !== null && data.length > 0) {
    const lastReal = data[data.length - 1]
    const lastTime = lastReal.time
    const lastVal  = lastReal.value
    const lastMmol = lastReal.mmol
    const predVal  = toDisplay(predictedIn20, unit)

    for (let min = 1; min <= 20; min++) {
      const frac = min / 20
      const t = lastTime + min * 60_000
      const v = lastVal  + (predVal       - lastVal)  * frac
      const m = lastMmol + (predictedIn20 - lastMmol) * frac
      predLineData.push({
        time: t,
        pred: parseFloat(v.toFixed(unit === 'mgdl' ? 0 : 1)),
        predMmol: m,
      })
    }
  }

  const timeMin = data[0]?.time ?? Date.now()
  const estimatedTimeMax = estimatedSegments
    .flat()
    .reduce((max, point) => Math.max(max, point.time), 0)
  const timeMax = Math.max(
    predLineData.length ? predLineData[predLineData.length - 1].time : 0,
    estimatedTimeMax,
    data[data.length - 1]?.time ?? Date.now(),
  )
  const timeSpanMs = timeMax - timeMin

  // Prediction line color based on where it ends up
  const lineColor = predictedIn20 !== null
    ? predColor(predictedIn20, 3.9, 10.0)
    : '#8b949e'

  // Only show dots at 5/10/15/20 min marks
  const lastTime = data[data.length - 1]?.time ?? 0
  const predDotData = predLineData
    .filter(p => {
      const minAhead = Math.round((p.time - lastTime) / 60_000)
      return minAhead % 5 === 0
    })
    .map(p => ({ time: p.time, value: p.pred, predMmol: p.predMmol }))

  // Bridge: a two-point dataset connecting last real → first pred, for the dashed line
  const bridgeData = data.length > 0 && predLineData.length > 0
    ? [
        { time: data[data.length - 1].time, pred: data[data.length - 1].value, predMmol: data[data.length - 1].mmol },
        ...predLineData,
      ]
    : []

  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart
        margin={{ top: 8, right: 20, bottom: 4, left: -8 }}
        onClick={(state: { activePayload?: Array<{ payload?: { time?: number } }> }) => {
          const ts = state?.activePayload?.[0]?.payload?.time
          if (typeof ts === 'number' && onSelectTimestamp) onSelectTimestamp(ts)
        }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#21262d" vertical={false} />
        <ReferenceArea y1={low} y2={high} fill="#3fb950" fillOpacity={0.06} ifOverflow="hidden" />

        <XAxis
          dataKey="time"
          type="number"
          domain={[timeMin, timeMax]}
          tickFormatter={ts => formatTick(ts, timeSpanMs)}
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
          content={<CustomTooltip unit={unit} lineColor={lineColor} timeSpanMs={timeSpanMs} />}
        />

        <ReferenceLine y={low}  stroke="#f85149" strokeDasharray="4 4" strokeWidth={1} opacity={0.6} />
        <ReferenceLine y={high} stroke="#d29922" strokeDasharray="4 4" strokeWidth={1} opacity={0.6} />

        {/* Historical connecting line, split so sensor gaps are not shown as real data */}
        {actualSegments.map((segment, i) => (
          <Line
            key={`actual-${i}`}
            data={segment}
            dataKey="value"
            type="monotone"
            stroke="#3fb950"
            strokeWidth={1.5}
            dot={false}
            activeDot={false}
            isAnimationActive={false}
            legendType="none"
          />
        ))}

        {/* Estimated line over sensor gaps */}
        {estimatedSegments.map((segment, i) => (
          <Line
            key={`estimated-${i}`}
            data={segment}
            dataKey="estimated"
            type="monotone"
            stroke={ESTIMATED_LINE_COLOR}
            strokeWidth={2}
            strokeDasharray="3 4"
            dot={false}
            activeDot={false}
            isAnimationActive={false}
            legendType="none"
            opacity={0.78}
          />
        ))}

        {/* Historical colored dots */}
        <Scatter data={data} isAnimationActive={false}>
          {data.map((entry, i) => (
            <Cell key={i} fill={STATUS_COLORS[entry.status]} opacity={0.9} r={3} />
          ))}
        </Scatter>

        {/* Prediction dashed line */}
        {bridgeData.length > 1 && (
          <Line
            data={bridgeData}
            dataKey="pred"
            type="monotone"
            stroke={lineColor}
            strokeWidth={2}
            strokeDasharray="6 4"
            dot={false}
            activeDot={false}
            isAnimationActive={false}
            legendType="none"
            opacity={0.8}
          />
        )}

        {/* Prediction dots (hollow) */}
        {predDotData.length > 0 && (
          <Scatter data={predDotData} isAnimationActive={false} shape={<HollowDot lineColor={lineColor} />}>
            {predDotData.map((_, i) => (
              <Cell key={i} fill="transparent" />
            ))}
          </Scatter>
        )}
      </ComposedChart>
    </ResponsiveContainer>
  )
}

function HollowDot({ cx, cy, lineColor }: { cx?: number; cy?: number; lineColor: string }) {
  if (cx === undefined || cy === undefined) return null
  return (
    <circle
      cx={cx}
      cy={cy}
      r={4}
      fill="#0d1117"
      stroke={lineColor}
      strokeWidth={1.5}
      opacity={0.8}
    />
  )
}

type ChartPoint = {
  time: number
  value: number
  mmol: number
  status: string
}

type EstimatedPoint = {
  time: number
  estimated: number
  estimatedMmol: number
}

function buildLineSegments(data: ChartPoint[], unit: 'mmol' | 'mgdl') {
  if (data.length === 0) return { actualSegments: [] as ChartPoint[][], estimatedSegments: [] as EstimatedPoint[][] }

  const expectedInterval = estimateExpectedIntervalMs(data)
  const gapThreshold = Math.max(MIN_GAP_MS, expectedInterval * 2.5)
  const actualSegments: ChartPoint[][] = []
  const estimatedSegments: EstimatedPoint[][] = []
  let currentSegment: ChartPoint[] = [data[0]]

  for (let i = 1; i < data.length; i++) {
    const prev = data[i - 1]
    const current = data[i]
    const gapMs = current.time - prev.time

    if (gapMs > gapThreshold) {
      actualSegments.push(currentSegment)
      currentSegment = [current]
      estimatedSegments.push([
        toEstimatedPoint(prev, unit),
        toEstimatedPoint(current, unit),
      ])
    } else {
      currentSegment.push(current)
    }
  }

  actualSegments.push(currentSegment)

  const openEstimate = buildOpenEstimate(data, gapThreshold, unit)
  if (openEstimate) estimatedSegments.push(openEstimate)

  return { actualSegments, estimatedSegments }
}

function estimateExpectedIntervalMs(data: ChartPoint[]) {
  const intervals = data
    .slice(1)
    .map((point, index) => point.time - data[index].time)
    .filter(interval => Number.isFinite(interval) && interval > 0)
    .sort((a, b) => a - b)

  if (intervals.length === 0) return 60_000
  return intervals[Math.floor(intervals.length / 2)]
}

function buildOpenEstimate(data: ChartPoint[], gapThreshold: number, unit: 'mmol' | 'mgdl') {
  const last = data.at(-1)
  if (!last) return null

  const now = Date.now()
  const staleMs = now - last.time
  if (staleMs <= gapThreshold || staleMs > MAX_OPEN_ESTIMATE_MS) return null

  const rate = recentRateMmolPerMs(data)
  if (rate === null) return null

  const estimatedMmol = Math.max(2, Math.min(18, last.mmol + rate * staleMs))
  return [
    toEstimatedPoint(last, unit),
    {
      time: now,
      estimated: toDisplay(estimatedMmol, unit),
      estimatedMmol,
    },
  ]
}

function recentRateMmolPerMs(data: ChartPoint[]) {
  const latest = data.at(-1)
  if (!latest) return null

  const baseline = [...data]
    .reverse()
    .find(point => point.time < latest.time && latest.time - point.time >= 4 * 60_000)

  if (!baseline) return null
  const dt = latest.time - baseline.time
  if (dt <= 0) return null

  return (latest.mmol - baseline.mmol) / dt
}

function toEstimatedPoint(point: ChartPoint, unit: 'mmol' | 'mgdl'): EstimatedPoint {
  return {
    time: point.time,
    estimated: toDisplay(point.mmol, unit),
    estimatedMmol: point.mmol,
  }
}

function formatTick(ts: number, spanMs = 0) {
  const d = new Date(ts)
  if (spanMs > 72 * 60 * 60 * 1000) {
    return `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`
  }
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function CustomTooltip({ active, payload, unit, lineColor, timeSpanMs }: {
  active?: boolean
  payload?: Array<{ payload: { time: number; value?: number; pred?: number; predMmol?: number; estimated?: number; estimatedMmol?: number; status?: string; ratePerMin?: number | null } }>
  unit?: 'mmol' | 'mgdl'
  lineColor?: string
  timeSpanMs?: number
}) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  const isPred = d.pred !== undefined && d.status === undefined
  const isEstimated = d.estimated !== undefined && d.status === undefined
  const val = isPred ? d.pred! : isEstimated ? d.estimated! : d.value!
  const color = isPred ? (lineColor ?? '#8b949e') : isEstimated ? ESTIMATED_LINE_COLOR : STATUS_COLORS[d.status ?? 'normal']
  const label = unit === 'mgdl' ? `${val} mg/dL` : `${typeof val === 'number' ? val.toFixed(1) : val} mmol/L`
  const rateText = d.ratePerMin !== null && d.ratePerMin !== undefined
    ? unit === 'mgdl'
      ? `${d.ratePerMin >= 0 ? '+' : ''}${(d.ratePerMin * 18.0182).toFixed(1)} mg/dL/min`
      : `${d.ratePerMin >= 0 ? '+' : ''}${d.ratePerMin.toFixed(2)} mmol/L/min`
    : null
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
        {isPred ? `~ ${label}` : label}
      </div>
      <div style={{ color: '#8b949e' }}>
        {formatTooltipTime(d.time, timeSpanMs)}{isPred ? ' (voorspelling)' : isEstimated ? ' (geschat)' : ''}
      </div>
      {!isPred && !isEstimated && rateText && (
        <div style={{ color: '#8b949e' }}>
          Snelheid: {rateText}
        </div>
      )}
    </div>
  )
}

function formatTooltipTime(ts: number, spanMs = 0) {
  const d = new Date(ts)
  const clock = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  if (spanMs > 72 * 60 * 60 * 1000) {
    return `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')} ${clock}`
  }
  return clock
}
