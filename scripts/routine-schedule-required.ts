import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { calculateRoutineSchedule as calculate, routineStartFromLocal, routineStartToLocal } from '../src/shared/routine-schedule'
import { createRoutine, listRoutines, updateRoutine, markRun } from '../src/main/routineStore'
import { computeNextRun, startRoutineScheduler, stopRoutineScheduler } from '../src/main/routineScheduler'

const roots: string[] = []
const instant = (value: string): number => Date.parse(value)
const next = (definition: Parameters<typeof calculate>[0], from: string): string | null => {
  const value = calculate(definition, instant(from)); assert.notEqual(value.state, 'invalid', value.error)
  return value.nextRunAt === null ? null : new Date(value.nextRunAt).toISOString()
}
let count = 0
async function check(name: string, body: () => Promise<void> | void): Promise<void> { await body(); count++; console.log(`PASS ${name}`) }
const root = (): string => { const value = mkdtempSync(join(tmpdir(), 'caogen-rrule-')); roots.push(value); return value }
const base = { name: 'Schedule fixture', prompt: 'Local fixture only', projectCwd: '/tmp', providerId: '', model: '' }
const realNow = Date.now
const originalZone = process.env.TZ

async function main(): Promise<void> {
  await check('legacy interval and cron retain their established local semantics', () => {
    process.env.TZ = 'Asia/Shanghai'
    assert.equal(computeNextRun('every 30m', instant('2026-09-17T00:00:00Z')), instant('2026-09-17T00:30:00Z'))
    assert.equal(computeNextRun('0 9 * * 1-5', instant('2026-09-17T00:00:00Z')), instant('2026-09-17T01:00:00Z'))
    assert.equal(computeNextRun('@daily', instant('2026-09-17T00:00:00Z')), instant('2026-09-17T16:00:00Z'))
  })
  await check('IANA RRULE is host-independent and tracks daylight saving at 09:00', () => {
    const definition = { schedule: 'RRULE:FREQ=DAILY;COUNT=3', timeZone: 'America/New_York', startAt: instant('2026-03-07T14:00:00Z') }
    for (const zone of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles']) {
      process.env.TZ = zone
      assert.equal(next(definition, '2026-03-07T14:00:00Z'), '2026-03-08T13:00:00.000Z')
      assert.equal(next(definition, '2026-03-08T13:00:00Z'), '2026-03-09T13:00:00.000Z')
    }
  })
  await check('DST gaps do not consume COUNT; repeated wall times run only once', () => {
    const gap = { schedule: 'RRULE:FREQ=DAILY;COUNT=3', timeZone: 'America/New_York', startAt: instant('2026-03-07T07:30:00Z') }
    assert.equal(next(gap, '2026-03-07T07:30:00Z'), '2026-03-09T06:30:00.000Z')
    assert.equal(next(gap, '2026-03-09T06:30:00Z'), '2026-03-10T06:30:00.000Z')
    assert.equal(calculate(gap, instant('2026-03-10T06:30:00Z')).state, 'exhausted')
    const fold = { schedule: 'RRULE:FREQ=DAILY;COUNT=3', timeZone: 'America/New_York', startAt: instant('2026-10-31T05:30:00Z') }
    assert.equal(next(fold, '2026-10-31T05:30:00Z'), '2026-11-01T05:30:00.000Z')
    assert.equal(next(fold, '2026-11-01T05:30:00Z'), '2026-11-02T06:30:00.000Z')
  })
  await check('UTC UNTIL is inclusive and finite rules are never reseeded past it', () => {
    const definition = { schedule: 'RRULE:FREQ=DAILY;UNTIL=20260309T130000Z', timeZone: 'America/New_York', startAt: instant('2026-03-07T14:00:00Z') }
    assert.equal(next(definition, '2026-03-08T13:00:00Z'), '2026-03-09T13:00:00.000Z')
    assert.equal(calculate(definition, instant('2026-03-09T13:00:00Z')).state, 'exhausted')
    assert.equal(calculate({ ...definition, schedule: 'RRULE:FREQ=DAILY;COUNT=2;UNTIL=20260309T130000Z' }, definition.startAt).state, 'invalid')
  })
  await check('calendar rules use the library for monthly BYSETPOS and fixed INTERVAL', () => {
    const monthly = { schedule: 'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3', timeZone: 'Asia/Shanghai', startAt: instant('2026-09-01T01:00:00Z') }
    assert.equal(next(monthly, '2026-09-01T01:00:00Z'), '2026-09-30T01:00:00.000Z')
    const interval = { schedule: 'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=4', timeZone: 'UTC', startAt: instant('2026-09-01T09:00:00Z') }
    assert.equal(next(interval, '2026-09-02T12:00:00Z'), '2026-09-03T09:00:00.000Z')
    assert.equal(next(interval, '2026-09-06T12:00:00Z'), '2026-09-07T09:00:00.000Z')
  })
  await check('editor wall-time conversion rejects gaps and chooses the first fold', () => {
    assert.throws(() => routineStartFromLocal('2026-03-08T02:30', 'America/New_York'), /不存在/)
    assert.equal(routineStartFromLocal('2026-11-01T01:30', 'America/New_York'), instant('2026-11-01T05:30:00Z'))
    assert.equal(routineStartToLocal(instant('2026-09-17T01:00:00Z'), 'Asia/Shanghai'), '2026-09-17T09:00:00')
    assert.equal(calculate({ schedule: '0 9 * * *', timeZone: 'Unknown/Zone' }, Date.now()).state, 'invalid')
  })
  await check('creation, persisted reload, timezone edits and old completion share the same next time', async () => {
    const dir = root(); Date.now = () => instant('2026-09-17T00:00:00Z')
    const old = await createRoutine(dir, { ...base, schedule: '0 9 * * *', timeZone: 'Asia/Shanghai', startAt: Date.now() })
    assert.equal(old.nextRunAt, instant('2026-09-17T01:00:00Z'))
    const changed = await updateRoutine(dir, old.id, { timeZone: 'America/New_York' })
    assert.equal(changed?.nextRunAt, instant('2026-09-17T13:00:00Z'))
    assert.equal(changed?.startAt, old.startAt)
    await markRun(dir, old.id, { ranAt: Date.now(), nextRunAt: old.nextRunAt, expectedSchedule: old })
    const reloaded = (await listRoutines(dir))[0]
    assert.equal(reloaded.nextRunAt, changed?.nextRunAt)
    assert.equal(reloaded.timeZone, 'America/New_York')
    assert.equal(reloaded.nextRunAt, calculate(reloaded, Date.now()).nextRunAt)
  })
  await check('COUNT exhaustion survives scheduler restart without a second trigger', async () => {
    const dir = root(); const startAt = instant('2026-09-17T01:00:00Z'); Date.now = () => startAt - 60000
    const routine = await createRoutine(dir, { ...base, schedule: 'RRULE:FREQ=DAILY;COUNT=1', timeZone: 'UTC', startAt })
    assert.equal(routine.nextRunAt, startAt)
    let triggers = 0
    Date.now = () => startAt
    let finished!: () => void
    const observed = new Promise<void>(resolve => { finished = resolve })
    startRoutineScheduler({ rootDir: dir, intervalMs: 10, now: Date.now, onTrigger: async (current, nextRunAt) => {
      triggers++; assert.equal(nextRunAt, null)
      await markRun(dir, current.id, { ranAt: startAt, nextRunAt, expectedSchedule: current }); finished()
    } })
    await Promise.race([observed, new Promise((_, reject) => setTimeout(() => reject(new Error('fixture scheduler timeout')), 1000))])
    stopRoutineScheduler()
    const stored = (await listRoutines(dir))[0]
    assert.equal(stored.scheduleState, 'exhausted'); assert.equal(stored.nextRunAt, undefined); assert.equal(stored.startAt, startAt)
    startRoutineScheduler({ rootDir: dir, intervalMs: 5, now: () => startAt + 86400000, onTrigger: () => { triggers++ } })
    await new Promise(resolve => setTimeout(resolve, 35)); stopRoutineScheduler(); assert.equal(triggers, 1)
    assert.equal(JSON.parse(readFileSync(join(dir, 'routines.json'), 'utf8')).routines[0].scheduleState, 'exhausted')
  })
  console.log(`routine-schedule: ${count}/${count} groups passed (temporary local fixtures, no model calls)`)
}
main().finally(() => { Date.now = realNow; if (originalZone === undefined) delete process.env.TZ; else process.env.TZ = originalZone; stopRoutineScheduler(); roots.forEach(value => rmSync(value, { force: true, recursive: true })) }).catch(error => { console.error(error); process.exitCode = 1 })
