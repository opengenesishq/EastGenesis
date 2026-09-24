import { useMemo, useState } from 'react'
import { evaluateVisualization, parseInlineVisualization, type InlineVisualization as Spec } from '../../../shared/inline-visualization'
import { appendComposerDraft } from '../store/composer-draft-inbox'
import './inline-visualization.css'

const COLORS = ['#4e80e8', '#d37742', '#35917e', '#a36ac2', '#c65c7b', '#68863d', '#708398', '#9d794c']
const format = (value: number): string => new Intl.NumberFormat(undefined, { maximumSignificantDigits: 5 }).format(value)
export default function InlineVisualization({ source, sessionId, messageId }: { source: string; sessionId?: string; messageId?: string }): React.JSX.Element {
  const parsed = useMemo(() => {
    try { return { spec: parseInlineVisualization(source) } } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
  }, [source])
  if (!parsed.spec) return <details className="inline-viz-invalid"><summary>可视化规格尚不完整</summary><p role="status">{parsed.error}</p><pre>{source}</pre></details>
  return <Visualization key={source} spec={parsed.spec} source={source} sessionId={sessionId} messageId={messageId} />
}
function Visualization({ spec, source, sessionId, messageId }: { spec: Spec; source: string; sessionId?: string; messageId?: string }): React.JSX.Element {
  const defaults = () => Object.fromEntries(spec.variables.map(v => [v.id, v.value]))
  const [variables, setVariables] = useState(defaults)
  const [hidden, setHidden] = useState<string[]>([])
  const [revision, setRevision] = useState('')
  const [status, setStatus] = useState('')
  const [selectedMarker, setSelectedMarker] = useState<number | null>(null)
  const result = useMemo(() => {
    try { return { data: evaluateVisualization(spec, variables) } } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
  }, [spec, variables])
  const stage = (): void => {
    if (!sessionId || !revision.trim()) return
    try {
      appendComposerDraft(sessionId, { payload: { text: `请修改当前任务中的可视化「${spec.title}」${messageId ? `（消息 ${messageId}）` : ''}。\n要求：${revision.trim()}\n当前参数：${JSON.stringify(variables)}\n原规格：\n\`\`\`caogen-viz\n${source}\n\`\`\`\n请返回完整的新版 caogen-viz 规格。` } })
      setRevision(''); setStatus('修改要求已加入原任务草稿，请确认后发送。')
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
  }
  return <section className="inline-viz" aria-label={spec.title} data-inline-viz={spec.kind}>
    <header><strong>{spec.title}</strong>{spec.variables.length > 0 && <button type="button" onClick={() => { setVariables(defaults()); setHidden([]) }}>重置参数</button>}</header>
    {spec.description && <p>{spec.description}</p>}
    {spec.variables.length > 0 && <div className="inline-viz-controls">{spec.variables.map(variable => <label key={variable.id}>
      <span>{variable.label}<output>{format(variables[variable.id])}</output></span>
      <input type="range" aria-label={variable.label} min={variable.min} max={variable.max} step={variable.step} value={variables[variable.id]}
        onChange={event => setVariables(current => ({ ...current, [variable.id]: Number(event.target.value) }))} />
      <small>{format(variable.min)} — {format(variable.max)}</small>
    </label>)}</div>}
    {result.error && <p role="status">{result.error}</p>}
    {result.data && <>
      {result.data.metrics.length > 0 && <dl className="inline-viz-metrics">{result.data.metrics.map((metric, index) => <div key={index}><dt>{metric.label}</dt><dd>{format(metric.value)} {metric.unit}</dd></div>)}</dl>}
      {spec.kind === 'chart' && <>
        <Chart spec={spec} series={result.data.series.filter((_, index) => !hidden.includes(String(index)))} />
        <div className="inline-viz-legend">{result.data.series.map((series, index) => <button type="button" key={index} aria-pressed={!hidden.includes(String(index))}
          onClick={() => setHidden(current => current.includes(String(index)) ? current.filter(value => value !== String(index)) : [...current, String(index)])}>{series.label}</button>)}</div>
        <details><summary>查看数据</summary><div className="inline-viz-table"><table><thead><tr><th>序列</th><th>{spec.xLabel || 'x'}</th><th>{spec.yLabel || 'y'}</th></tr></thead><tbody>
          {result.data.series.flatMap((series, index) => series.points.map((point, i) => <tr key={`${index}-${i}`}><td>{series.label}</td><td>{format(point.x)}</td><td>{format(point.y)}</td></tr>))}
        </tbody></table></div></details>
      </>}
    </>}
    {spec.kind === 'map' && <>
      <svg className="inline-viz-plot" viewBox="0 0 660 330" role="img" aria-label="经纬度位置示意图">
        <rect x="1" y="1" width="658" height="328" fill="var(--bg-input, var(--bg))" stroke="currentColor" opacity=".3" />
        {[-120, -60, 0, 60, 120].map(lon => <line key={lon} x1={(lon + 180) * 660 / 360} y1="0" x2={(lon + 180) * 660 / 360} y2="330" stroke="currentColor" opacity=".12" />)}
        {[-60, -30, 0, 30, 60].map(lat => <line key={lat} x1="0" y1={(90 - lat) * 330 / 180} x2="660" y2={(90 - lat) * 330 / 180} stroke="currentColor" opacity=".12" />)}
        {spec.markers.map((marker, index) => <g key={index} role="button" tabIndex={0} aria-label={`${marker.label}，${marker.lat}，${marker.lon}`} onClick={() => setSelectedMarker(index)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedMarker(index) } }}>
          <circle cx={(marker.lon + 180) * 660 / 360} cy={(90 - marker.lat) * 330 / 180} r={selectedMarker === index ? 8 : 5} fill={COLORS[index % COLORS.length]} /><title>{marker.label}</title>
        </g>)}
      </svg>
      <p className="inline-viz-note">经纬度位置示意，不含地形底图。选择地点查看坐标。</p>
      <select aria-label="选择地点" value={selectedMarker ?? ''} onChange={event => setSelectedMarker(event.target.value ? Number(event.target.value) : null)}>
        <option value="">选择地点</option>{spec.markers.map((marker, index) => <option key={index} value={index}>{marker.label} · {marker.lat}, {marker.lon}</option>)}
      </select>
      {selectedMarker !== null && <output>{spec.markers[selectedMarker].label} · 纬度 {spec.markers[selectedMarker].lat}，经度 {spec.markers[selectedMarker].lon}</output>}
    </>}
    <details><summary>查看可视化规格</summary><pre>{source}</pre></details>
    {sessionId && <div className="inline-viz-revise"><textarea aria-label="修改可视化的要求" placeholder="例如：加上同比数据，改成柱状图" value={revision} maxLength={4000} rows={2} onChange={event => setRevision(event.target.value)} /><button type="button" disabled={!revision.trim()} onClick={stage}>加入修改草稿</button></div>}
    {status && <p role="status">{status}</p>}
  </section>
}

function Chart({ spec, series }: { spec: Spec; series: ReturnType<typeof evaluateVisualization>['series'] }): React.JSX.Element {
  const points = series.flatMap(s => s.points)
  if (!points.length) return <p>选择至少一组数据以显示图表。</p>
  let minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x))
  let minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y))
  if (spec.chart === 'bar') { minY = Math.min(0, minY); maxY = Math.max(0, maxY) }
  if (minX === maxX) { minX -= 1; maxX += 1 }
  if (minY === maxY) { minY -= 1; maxY += 1 }
  const x = (value: number) => 70 + (value - minX) / (maxX - minX) * 550
  const y = (value: number) => 260 - (value - minY) / (maxY - minY) * 220
  return <svg className="inline-viz-plot" viewBox="0 0 660 310" role="img" aria-label={`${spec.title}，${spec.xLabel || 'x'} / ${spec.yLabel || 'y'}`}>
    {[0, 1, 2, 3, 4].map(i => { const value = minY + (maxY - minY) * i / 4; return <g key={i}><line x1="70" x2="620" y1={y(value)} y2={y(value)} stroke="currentColor" opacity=".13" /><text x="62" y={y(value) + 4} textAnchor="end">{format(value)}</text></g> })}
    <text x="70" y="279">{format(minX)}</text><text x="620" y="279" textAnchor="end">{format(maxX)}</text>
    <text x="345" y="302" textAnchor="middle">{spec.xLabel}</text><text x="70" y="21">{spec.yLabel}</text>
    {series.map((s, index) => <g key={index} fill={COLORS[index % COLORS.length]}>
      {spec.chart === 'line' && <polyline points={s.points.map(p => `${x(p.x)},${y(p.y)}`).join(' ')} fill="none" stroke={COLORS[index % COLORS.length]} strokeWidth="2" />}
      {s.points.map((p, i) => spec.chart === 'bar'
        ? <rect key={i} x={x(p.x) - 4 + index * 2} y={Math.min(y(p.y), y(0))} width={Math.max(1, Math.min(12, 400 / points.length))} height={Math.max(1, Math.abs(y(p.y) - y(0)))}><title>{s.label}: {format(p.x)}, {format(p.y)}</title></rect>
        : <circle key={i} cx={x(p.x)} cy={y(p.y)} r={spec.chart === 'scatter' ? 4 : 2}><title>{s.label}: {format(p.x)}, {format(p.y)}</title></circle>)}
    </g>)}
  </svg>
}
