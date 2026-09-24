import type { SessionFollowUpBehavior } from '../../../../shared/session-follow-up'

export default function SessionFollowUpSelect({ value, onChange, zh = true }: {
  value: SessionFollowUpBehavior; onChange(value: SessionFollowUpBehavior): void; zh?: boolean
}): React.JSX.Element {
  return <label className="composer-follow-up-choice">{zh ? '运行中追问' : 'Follow-ups while running'}
    <select className="select" aria-label={zh ? '运行中追问行为' : 'Follow-up behavior'} value={value} onChange={event => onChange(event.target.value as SessionFollowUpBehavior)}>
      <option value="queue">{zh ? '本轮结束后自动继续' : 'Queue for the next turn'}</option>
      <option value="pause_and_apply">{zh ? '安全暂停后应用' : 'Pause safely and apply'}</option>
      <option value="manual">{zh ? '保存后手动继续' : 'Save for manual continuation'}</option>
    </select>
  </label>
}
