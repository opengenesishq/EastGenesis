import { normalizeMemoryPreferences, type MemoryPreferences } from '../../../../shared/memory-preferences-types'

export default function MemoryPreferencesSettings({ value, language, onChange }: {
  value?: MemoryPreferences
  language: 'zh' | 'en'
  onChange(value: MemoryPreferences): void
}): React.JSX.Element {
  const preferences = normalizeMemoryPreferences(value)
  const zh = language === 'zh'
  return <section className="settings-section" aria-label={zh ? '记忆默认设置' : 'Memory defaults'}>
    <h3 className="settings-h3">{zh ? '记忆' : 'Memory'}</h3>
    <p className="settings-hint">{zh ? '为所有任务设置默认行为。任务的记忆面板可以单独覆盖；关闭开关保留历史记录与已有对话。' : 'Set defaults for every task. Override them in a task’s memory panel. Turning a switch off keeps saved records and existing conversation context.'}</p>
    <label className="settings-toggle"><input type="checkbox" checked={preferences.useSharedMemory}
      onChange={event => onChange({ ...preferences, useSharedMemory: event.target.checked })} />
      {zh ? '使用共享记忆' : 'Use shared memory'}</label>
    <p className="field-hint">{zh ? '在后续请求中检索项目、个人及员工记忆。当前任务专属记忆始终独立可用。' : 'Retrieve project, personal, and worker memories for subsequent requests. Task-specific memory remains available independently.'}</p>
    <label className="settings-toggle"><input type="checkbox" checked={preferences.contributeSharedMemory}
      onChange={event => onChange({ ...preferences, contributeSharedMemory: event.target.checked })} />
      {zh ? '贡献共享记忆' : 'Contribute shared memory'}</label>
    <p className="field-hint">{zh ? '允许提出、采纳及修订共享记忆；草稿仍需用户确认。关闭后仍可查看、删除记录和保存当前任务记忆。' : 'Allow proposing, accepting, and revising shared memories. Drafts still require approval. Viewing, deleting, and saving task-only memories remain available when disabled.'}</p>
  </section>
}
