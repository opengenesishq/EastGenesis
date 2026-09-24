import { useEffect, useState } from 'react'
import { calculateRoutineSchedule, isRRuleSchedule, routineStartFromLocal } from '../../../../shared/routine-schedule'

export default function RoutineScheduleFields({ schedule, timeZone, startLocal, onTimeZone, onStartLocal, zh }: {
  schedule: string; timeZone: string; startLocal: string; onTimeZone(value: string): void; onStartLocal(value: string): void; zh: boolean
}): React.JSX.Element {
  const [preview, setPreview] = useState('')
  const rrule = isRRuleSchedule(schedule)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const startAt = rrule ? routineStartFromLocal(startLocal, timeZone) : undefined
        const result = calculateRoutineSchedule({ schedule, timeZone: timeZone || undefined, startAt }, Date.now())
        setPreview(result.state === 'invalid' ? result.error! : result.state === 'exhausted'
          ? zh ? '排期已结束，COUNT 次数或 UNTIL 截止已用尽。' : 'Schedule ended: COUNT or UNTIL has been reached.'
          : `${zh ? '下次运行：' : 'Next run: '}${new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en', {
            timeZone: timeZone || undefined, dateStyle: 'medium', timeStyle: 'long'
          }).format(result.nextRunAt!)} · ${timeZone || (zh ? '跟随电脑时区（旧计划）' : 'Computer time zone (legacy)')}`)
      } catch (error) { setPreview(error instanceof Error ? error.message : String(error)) }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [schedule, startLocal, timeZone, zh, rrule])
  return <div className="routine-schedule-fields">
    <label className="field-label" htmlFor="routine-time-zone">{zh ? '时区（IANA）' : 'Time zone (IANA)'}</label>
    <input id="routine-time-zone" className="input input-block" list="routine-time-zone-examples" value={timeZone} placeholder="Asia/Shanghai" onChange={event => onTimeZone(event.target.value)} />
    <datalist id="routine-time-zone-examples">{['Asia/Shanghai', 'Asia/Tokyo', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'UTC'].map(zone => <option key={zone} value={zone} />)}</datalist>
    {!timeZone && <p className="field-hint">{zh ? '旧 cron 计划继续跟随电脑时区；填写明确时区后按该地区的日历时间运行。' : 'Legacy cron follows this computer. Set a zone to use its local calendar time.'}</p>}
    {rrule && <>
      <label className="field-label" htmlFor="routine-start-at">{zh ? '固定起始时间（所选时区）' : 'Fixed start (selected time zone)'}</label>
      <input id="routine-start-at" className="input input-block" type="datetime-local" step="1" value={startLocal} onChange={event => onStartLocal(event.target.value)} />
      <p className="field-hint">{zh ? '次数从此起点累计，重启不重置。夏令时不存在的时刻跳过且不计次数，重复时刻只取第一次。UNTIL 使用 UTC，例如 20261231T155959Z。' : 'COUNT is anchored here and survives restart. DST gaps are skipped without counting; repeated times use their first occurrence. UNTIL uses UTC, for example 20261231T155959Z.'}</p>
    </>}
    <p className="field-hint" role="status" data-routine-schedule-preview>{preview}</p>
  </div>
}
