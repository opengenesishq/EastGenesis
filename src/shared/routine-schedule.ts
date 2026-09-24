import { RRule } from 'rrule'
import { DateTime } from 'luxon'
import { CronExpressionParser } from 'cron-parser'
import { computeLegacyNextRun } from './routine-legacy-schedule'

export interface RoutineScheduleDefinition {
  schedule: string
  /** Absent only for legacy definitions, which retain the original host-local cron semantics. */
  timeZone?: string
  /** Absolute instant anchoring DTSTART. Never moved by a run or an application restart. */
  startAt?: number
}
export type RoutineScheduleState = 'active' | 'exhausted' | 'invalid'
export interface RoutineScheduleResult { nextRunAt: number | null; state: RoutineScheduleState; error?: string }

export function normalizeRoutineTimeZone(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) throw new Error('请输入有效 IANA 时区，例如 Asia/Shanghai')
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone }
  catch { throw new Error('此 IANA 时区不可用，请检查时区名称') }
}

export function normalizeRoutineStartAt(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 253402214399000) throw new Error('计划起始时间无效')
  return Math.floor(value / 1000) * 1000
}

export function isRRuleSchedule(schedule: string): boolean { return /^RRULE:/i.test(schedule.trim()) || /(?:^|;)FREQ=/i.test(schedule.trim()) }

/** Parse a wall-clock editor value in its selected zone. DST gaps are never silently moved. */
export function routineStartFromLocal(local: string, timeZone: string): number {
  const zone = normalizeRoutineTimeZone(timeZone)
  const parsed = DateTime.fromISO(local, { zone })
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(local) || !parsed.isValid ||
      parsed.toFormat(local.length > 16 ? "yyyy-MM-dd'T'HH:mm:ss" : "yyyy-MM-dd'T'HH:mm") !== local) throw new Error('此本地时间不存在或格式无效，请检查夏令时与起始时间')
  return Math.min(...parsed.getPossibleOffsets().map(value => value.toMillis()))
}

export function routineStartToLocal(timestamp: number, timeZone?: string): string {
  return DateTime.fromMillis(timestamp, { zone: timeZone }).toFormat("yyyy-MM-dd'T'HH:mm:ss")
}

/** Shared by persisted definitions, scheduler, manual execution, and the editor preview. */
export function calculateRoutineSchedule(definition: RoutineScheduleDefinition, from: number): RoutineScheduleResult {
  try {
    if (!Number.isFinite(from) || typeof definition.schedule !== 'string' || definition.schedule.length > 4096) throw new Error('计划时间格式无效')
    const schedule = definition.schedule.trim()
    const zone = normalizeRoutineTimeZone(definition.timeZone)
    const startAt = normalizeRoutineStartAt(definition.startAt)
    if (!schedule) throw new Error('请输入运行时间')
    if (isRRuleSchedule(schedule)) {
      if (!zone || startAt === undefined) throw new Error('RRULE 需要明确的 IANA 时区和固定起始时间')
      return nextRecurrence(schedule, zone, startAt, from)
    }
    if (/^(?:every\s+)?\d+\s*[smhd]$/i.test(schedule)) {
      const next = computeLegacyNextRun(schedule, from)
      if (next === null || !Number.isSafeInteger(next)) throw new Error('间隔时间无效')
      return { nextRunAt: next, state: 'active' }
    }
    // Existing definitions without a zone continue using their original parser and local-time rules.
    if (!zone) {
      const next = computeLegacyNextRun(schedule, from)
      if (next === null) throw new Error('cron 无效或未来 366 天没有匹配时间')
      return { nextRunAt: next, state: 'active' }
    }
    if (!schedule.startsWith('@') && schedule.split(/\s+/).length !== 5) throw new Error('使用五段 cron、every 30m 或 RRULE:FREQ=…')
    const expression = CronExpressionParser.parse(schedule, { currentDate: from, tz: zone })
    return { nextRunAt: expression.next().getTime(), state: 'active' }
  } catch (error) {
    return { nextRunAt: null, state: 'invalid', error: error instanceof Error ? error.message : String(error) }
  }
}

function nextRecurrence(schedule: string, zone: string, startAt: number, from: number): RoutineScheduleResult {
  if (/[\r\n]/.test(schedule) || /(?:^|;)(?:DTSTART|TZID)=/i.test(schedule)) throw new Error('仅填写一条 RRULE；起始时间与时区在下方单独设置')
  const raw = schedule.replace(/^RRULE:/i, '').toUpperCase()
  const keys = raw.split(';').map(part => part.split('=')[0])
  if (new Set(keys).size !== keys.length) throw new Error('RRULE 中的规则字段不能重复')
  const options = RRule.parseString(raw)
  if (options.freq === undefined || (options.interval !== undefined && (!Number.isSafeInteger(options.interval) || options.interval < 1))) throw new Error('RRULE 频率或 INTERVAL 无效')
  if (options.count !== undefined && options.count !== null && (!Number.isSafeInteger(options.count) || options.count < 1)) throw new Error('RRULE COUNT 必须为正整数')
  if (options.count && options.until) throw new Error('RRULE COUNT 和 UNTIL 不能同时使用')
  if (options.until && !/(?:^|;)UNTIL=\d{8}T\d{6}Z(?:;|$)/.test(raw)) throw new Error('UNTIL 使用 UTC 时间，例如 20261231T155959Z')
  const until = options.until?.getTime()
  const count = options.count ?? undefined
  if (options.until) {
    const value = /(?:^|;)UNTIL=([^;]+)/.exec(raw)?.[1]
    if (!value || DateTime.fromJSDate(options.until, { zone: 'UTC' }).toFormat("yyyyMMdd'T'HHmmss'Z'") !== value) throw new Error('RRULE UNTIL 日期无效')
  }
  const localStart = DateTime.fromMillis(startAt, { zone })
  const wallStart = wallDate(localStart)
  // Run the mature recurrence engine in floating UTC; tzid in rrule 2.8.1 depends on the host TZ.
  const horizon = Math.min(until ?? Infinity, Math.max(from, startAt) + 8 * 366 * 86400000)
  const rule = new RRule({ ...options, dtstart: wallStart, tzid: null, count: null,
    until: new Date(wallDate(DateTime.fromMillis(horizon, { zone })).getTime() + 86400000) }, true)
  let nextRunAt: number | null = null
  let validCount = 0
  let exhausted = until !== undefined && from >= until
  let inspected = 0
  const inspect = (wall: Date): boolean => {
    if (++inspected > 100000) throw new Error('此规则从起点累计超过 100000 个候选时间，请缩小规则范围或调整起点')
    const local = DateTime.fromObject({ year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1,
      day: wall.getUTCDate(), hour: wall.getUTCHours(), minute: wall.getUTCMinutes(), second: wall.getUTCSeconds() }, { zone })
    // RFC recurrence gaps do not count; folds choose the first occurrence exactly once.
    if (!local.isValid || wallDate(local).getTime() !== wall.getTime()) return true
    const instant = Math.min(...local.getPossibleOffsets().map(value => value.toMillis()))
    if (instant < startAt) return true
    if (until !== undefined && instant > until) { exhausted = true; return false }
    validCount++
    if (instant > from) { nextRunAt = instant; return false }
    if (count !== undefined && validCount >= count) { exhausted = true; return false }
    return true
  }
  if (count === undefined) {
    // No COUNT means no historical tally is needed. The recurrence library keeps the original DTSTART.
    let cursor = new Date(Math.max(wallStart.getTime() - 1, wallDate(DateTime.fromMillis(from, { zone })).getTime() - 1))
    for (let wall = rule.after(cursor); wall; wall = rule.after(cursor)) {
      if (!inspect(wall)) break
      cursor = wall
    }
  } else rule.all(inspect)
  if (nextRunAt !== null) return { nextRunAt, state: 'active' }
  if (exhausted || (until !== undefined && until <= horizon)) return { nextRunAt: null, state: 'exhausted' }
  throw new Error('此 RRULE 在未来 8 年没有可用时间，请检查规则或起始时间')
}

function wallDate(value: DateTime): Date { return new Date(Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second)) }
