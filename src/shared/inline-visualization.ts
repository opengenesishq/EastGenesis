/** Declarative inline content. No HTML, script, network URL or executable extension is accepted. */
export interface VizVariable { id: string; label: string; min: number; max: number; step: number; value: number }
export interface VizMetric { label: string; expression: string; unit?: string }
export interface VizSeries { label: string; points?: { x: number; y: number | string }[]; expression?: string; min?: number; max?: number; samples?: number }
export interface VizMarker { label: string; lat: number; lon: number }
export interface InlineVisualization {
  version: 1; kind: 'chart' | 'calculator' | 'map'; title: string; description?: string
  chart?: 'line' | 'bar' | 'scatter'; xLabel?: string; yLabel?: string
  variables: VizVariable[]; metrics: VizMetric[]; series: VizSeries[]; markers: VizMarker[]
}

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  abs: Math.abs, sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  log: Math.log, exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  min: Math.min, max: Math.max, pow: Math.pow
}
type Expr = { type: 'number'; value: number } | { type: 'variable'; name: string } |
  { type: 'unary'; sign: number; value: Expr } | { type: 'binary'; op: string; left: Expr; right: Expr } |
  { type: 'call'; name: string; args: Expr[] }

export function compileVizExpression(source: string): (variables: Record<string, number>) => number {
  if (!source || source.length > 1000) throw new Error('公式长度须为 1–1000 字符。')
  const tokens: string[] = []
  const pattern = /\s*(?:(\d+(?:\.\d*)?(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)|([A-Za-z_][A-Za-z_0-9]*)|([+*/^(),-]))/iy
  let offset = 0
  while (offset < source.trimEnd().length) {
    pattern.lastIndex = offset
    const match = pattern.exec(source)
    if (!match || tokens.length >= 256) throw new Error('公式只支持数值、变量和有限数学运算。')
    tokens.push(match[1] ?? match[2] ?? match[3]); offset = pattern.lastIndex
  }
  let index = 0
  const expression = (minimum = 0, depth = 0): Expr => {
    if (depth > 32) throw new Error('公式嵌套过深。')
    const token = tokens[index++]
    let left: Expr
    if (token === '-' || token === '+') left = { type: 'unary', sign: token === '-' ? -1 : 1, value: expression(3, depth + 1) }
    else if (token === '(') {
      left = expression(0, depth + 1)
      if (tokens[index++] !== ')') throw new Error('公式括号不匹配。')
    } else if (token && /^(?:\d|\.)/.test(token)) left = { type: 'number', value: Number(token) }
    else if (token && /^[A-Za-z_]/.test(token)) {
      if (tokens[index] === '(') {
        if (!Object.hasOwn(FUNCTIONS, token)) throw new Error(`不支持函数：${token}`)
        index++
        const args: Expr[] = [expression(0, depth + 1)]
        while (tokens[index] === ',' && args.length < 12) { index++; args.push(expression(0, depth + 1)) }
        if (tokens[index++] !== ')') throw new Error('函数参数格式无效。')
        const validArity = token === 'min' || token === 'max' ? args.length >= 1 : args.length === (token === 'pow' ? 2 : 1)
        if (!validArity) throw new Error('函数参数数量无效。')
        left = { type: 'call', name: token, args }
      } else left = { type: 'variable', name: token }
    } else throw new Error('公式缺少数值。')
    while (index < tokens.length) {
      const op = tokens[index]
      const priority = op === '+' || op === '-' ? 1 : op === '*' || op === '/' ? 2 : op === '^' ? 3 : -1
      if (priority < minimum) break
      index++
      left = { type: 'binary', op, left, right: expression(priority + (op === '^' ? 0 : 1), depth + 1) }
    }
    return left
  }
  const root = expression()
  if (index !== tokens.length) throw new Error('公式含有无法识别的内容。')
  return variables => {
    const evaluate = (node: Expr): number => {
      if (node.type === 'number') return node.value
      if (node.type === 'variable') {
        if (node.name === 'pi') return Math.PI
        if (node.name === 'e') return Math.E
        if (!Object.hasOwn(variables, node.name)) throw new Error(`未知变量：${node.name}`)
        return variables[node.name]
      }
      if (node.type === 'unary') return node.sign * evaluate(node.value)
      if (node.type === 'call') return FUNCTIONS[node.name](...node.args.map(evaluate))
      const a = evaluate(node.left), b = evaluate(node.right)
      return node.op === '+' ? a + b : node.op === '-' ? a - b : node.op === '*' ? a * b : node.op === '/' ? a / b : a ** b
    }
    const value = evaluate(root)
    if (!Number.isFinite(value) || Math.abs(value) > 1e100) throw new Error('当前参数无法得到有限结果，请调整参数。')
    return value
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('可视化规格必须是对象。')
  return value as Record<string, unknown>
}
function label(value: unknown, optional = false): string {
  if (optional && value === undefined) return ''
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw new Error('可视化文字格式无效。')
  return value.trim()
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12) throw new Error('可视化数值超出范围。')
  return value
}
function list(value: unknown, max: number): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max) throw new Error(`可视化列表最多允许 ${max} 项。`)
  return value
}
export function parseInlineVisualization(source: string): InlineVisualization {
  if (source.length > 128000) throw new Error('可视化规格超过 128 KB。')
  const raw = record(JSON.parse(source))
  if (raw.version !== 1 || !['chart', 'calculator', 'map'].includes(String(raw.kind))) throw new Error('不支持此可视化版本或类型。')
  const variables = list(raw.variables, 12).map(item => {
    const v = record(item), id = label(v.id)
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(id) || ['x', 'e', 'pi'].includes(id) || Object.hasOwn(FUNCTIONS, id)) throw new Error('参数名称无效或已保留。')
    const min = number(v.min), max = number(v.max), step = number(v.step ?? (max - min) / 100), value = number(v.value)
    if (max <= min || step <= 0 || step > max - min || value < min || value > max) throw new Error('参数范围无效。')
    return { id, label: label(v.label), min, max, step, value }
  })
  if (new Set(variables.map(v => v.id)).size !== variables.length) throw new Error('参数名称重复。')
  const checkExpression = (value: unknown): string => { const text = label(value); compileVizExpression(text); return text }
  const metrics = list(raw.metrics, 12).map(item => {
    const v = record(item)
    return { label: label(v.label), expression: checkExpression(v.expression), unit: label(v.unit, true) }
  })
  const series = list(raw.series, 8).map((item): VizSeries => {
    const v = record(item)
    if (v.expression !== undefined) {
      const min = number(v.min), max = number(v.max), samples = number(v.samples ?? 101)
      if (min >= max || !Number.isInteger(samples) || samples < 2 || samples > 250) throw new Error('曲线范围或采样数量无效。')
      return { label: label(v.label), expression: checkExpression(v.expression), min, max, samples }
    }
    const points = list(v.points, 250).map(p => { const point = record(p); return { x: number(point.x), y: typeof point.y === 'number' ? number(point.y) : checkExpression(point.y) } })
    if (!points.length) throw new Error('曲线缺少数据。')
    return { label: label(v.label), points }
  })
  const markers = list(raw.markers, 150).map(item => {
    const v = record(item), lat = number(v.lat), lon = number(v.lon)
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('地图坐标超出范围。')
    return { label: label(v.label), lat, lon }
  })
  if (raw.kind === 'chart' && !series.length || raw.kind === 'calculator' && !metrics.length || raw.kind === 'map' && !markers.length) throw new Error('可视化缺少内容。')
  if (raw.chart !== undefined && !['line', 'bar', 'scatter'].includes(String(raw.chart))) throw new Error('不支持此图表类型。')
  return { version: 1, kind: raw.kind as InlineVisualization['kind'], title: label(raw.title), description: label(raw.description, true),
    chart: (raw.chart ?? 'line') as InlineVisualization['chart'], xLabel: label(raw.xLabel, true), yLabel: label(raw.yLabel, true), variables, metrics, series, markers }
}

export function evaluateVisualization(spec: InlineVisualization, variables: Record<string, number>) {
  return {
    metrics: spec.metrics.map(metric => ({ ...metric, value: compileVizExpression(metric.expression)(variables) })),
    series: spec.series.map(series => {
      if (series.expression) {
        const evaluate = compileVizExpression(series.expression)
        return { label: series.label, points: Array.from({ length: series.samples! }, (_, i) => {
          const x = series.min! + (series.max! - series.min!) * i / (series.samples! - 1)
          return { x, y: evaluate({ ...variables, x }) }
        }) }
      }
      return { label: series.label, points: series.points!.map(point => ({ x: point.x, y: typeof point.y === 'number' ? point.y : compileVizExpression(point.y)({ ...variables, x: point.x }) })) }
    })
  }
}

export const INLINE_VISUALIZATION_PROMPT = `When an inline interactive chart, calculator, coordinate map or parameter simulation helps, emit a fenced code block with language caogen-viz and JSON (not HTML/JavaScript). Schema: version:1, kind:chart|calculator|map, title, optional description. variables:[{id,label,min,max,step,value}] make sliders; metrics:[{label,expression,unit?}]. chart uses chart:line|bar|scatter, xLabel,yLabel, series:[{label,points:[{x:number,y:number|expression}]}] or series:[{label,expression,min,max,samples:101}] with x as the sampled variable. map uses markers:[{label,lat,lon}] (a coordinate schematic, no map tiles). Expressions support + - * / ^, parentheses, pi/e, declared variables and x, abs/sqrt/sin/cos/tan/log/exp/floor/ceil/round/min/max/pow. No arbitrary code, URLs, network or files. Maximum 12 variables, 12 metrics, 8 series, 250 points per series, 150 markers; finite numbers <= 1e12. Use sourced data or explicitly label assumptions. Follow-up edits should return a complete updated caogen-viz block. Example: {"version":1,"kind":"calculator","title":"Cost estimate","variables":[{"id":"hours","label":"Hours","min":1,"max":100,"step":1,"value":10}],"metrics":[{"label":"Cost","expression":"hours * 20","unit":"USD"}]}.`
