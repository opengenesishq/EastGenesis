// Preserved legacy interval and host-local cron semantics.
const CRON_SEARCH_LIMIT_MINUTES = 366 * 24 * 60
const MINUTE_MS = 60_000
const CRON_ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *'
}

function normalizeCronAlias(expr: string): string {
  const trimmed = expr.trim()
  return CRON_ALIASES[trimmed.toLowerCase()] ?? trimmed
}


export function computeLegacyNextRun(schedule: string, from: number): number | null {
  if (typeof schedule !== 'string') return null
  const trimmed = schedule.trim()
  if (trimmed === '') return null

  const interval = parseIntervalSchedule(trimmed)
  if (interval !== null) {
    if (interval <= 0) return null
    return from + interval
  }

  return computeNextCron(normalizeCronAlias(trimmed), from)
}

/** 解析间隔式表达式,返回毫秒;非间隔式返回 null */
function parseIntervalSchedule(input: string): number | null {
  const match = /^(?:every\s+)?(\d+)\s*([smhd])$/i.exec(input)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return 0 // 触发上层返回 null
  const unit = match[2].toLowerCase()
  const unitMs = unit === 's' ? 1_000 : unit === 'm' ? MINUTE_MS : unit === 'h' ? 3_600_000 : 86_400_000
  return value * unitMs
}

interface CronSpec {
  minute: number[]
  hour: number[]
  dom: number[]
  month: number[]
  dow: number[]
  domRestricted: boolean
  dowRestricted: boolean
}

function computeNextCron(input: string, from: number): number | null {
  const spec = parseCron(input)
  if (!spec) return null

  // 从下一分钟起搜索(cron 精度为分钟)
  const start = new Date(from)
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)

  const cursor = new Date(start)
  for (let i = 0; i < CRON_SEARCH_LIMIT_MINUTES; i++) {
    if (cronMatches(spec, cursor)) return cursor.getTime()
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return null
}

function cronMatches(spec: CronSpec, date: Date): boolean {
  if (!spec.minute.includes(date.getMinutes())) return false
  if (!spec.hour.includes(date.getHours())) return false
  if (!spec.month.includes(date.getMonth() + 1)) return false

  const domOk = spec.dom.includes(date.getDate())
  // getDay(): 0=周日..6=周六;spec.dow 已把 7 归一为 0
  const dowOk = spec.dow.includes(date.getDay())

  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk
  if (spec.domRestricted) return domOk
  if (spec.dowRestricted) return dowOk
  return true
}

function parseCron(input: string): CronSpec | null {
  const fields = input.split(/\s+/)
  if (fields.length !== 5) return null

  const minute = parseCronField(fields[0], 0, 59)
  const hour = parseCronField(fields[1], 0, 23)
  const dom = parseCronField(fields[2], 1, 31)
  const month = parseCronField(fields[3], 1, 12)
  const dowRaw = parseCronField(fields[4], 0, 7)
  if (!minute || !hour || !dom || !month || !dowRaw) return null

  // 归一化 day-of-week:7 -> 0(都表示周日),并去重排序
  const dow = Array.from(new Set(dowRaw.map((d) => (d === 7 ? 0 : d)))).sort((a, b) => a - b)

  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*'
  }
}

/** 解析单个 cron 字段为其匹配的整数集合;非法返回 null */
function parseCronField(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    if (part === '') return null
    const parsed = parseCronPart(part, min, max)
    if (!parsed) return null
    for (const v of parsed) values.add(v)
  }
  if (values.size === 0) return null
  return Array.from(values).sort((a, b) => a - b)
}

function parseCronPart(part: string, min: number, max: number): number[] | null {
  let step = 1
  let rangePart = part

  const slash = part.indexOf('/')
  if (slash !== -1) {
    rangePart = part.slice(0, slash)
    const stepStr = part.slice(slash + 1)
    step = Number(stepStr)
    if (!Number.isInteger(step) || step <= 0 || stepStr.trim() === '') return null
  }

  let lo: number
  let hi: number

  if (rangePart === '*') {
    lo = min
    hi = max
  } else if (rangePart.includes('-')) {
    const [loStr, hiStr] = rangePart.split('-')
    lo = Number(loStr)
    hi = Number(hiStr)
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null
  } else {
    const single = Number(rangePart)
    if (!Number.isInteger(single)) return null
    lo = single
    hi = single
  }

  if (lo < min || hi > max || lo > hi) return null

  const out: number[] = []
  for (let v = lo; v <= hi; v += step) out.push(v)
  return out
}
