import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryOverrides, MemoryPreferences, TaskMemoryPreferences as Snapshot } from '../../../shared/memory-preferences-types'

export function useTaskMemoryPreferences(sessionId: string) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const generation = useRef(0)
  const alive = useRef(false)
  const mutation = useRef(false)
  const refresh = useCallback(async (): Promise<void> => {
    const token = ++generation.current
    try {
      const next = await window.agentDesk.readTaskMemoryPreferences(sessionId)
      if (alive.current && token === generation.current) { setSnapshot(next); setError('') }
    } catch (failure) {
      if (alive.current && token === generation.current) setError(String(failure instanceof Error ? failure.message : failure))
    }
  }, [sessionId])
  useEffect(() => {
    alive.current = true
    setSnapshot(null)
    void refresh()
    const stopSettings = window.agentDesk.onSettingsChanged(() => { void refresh() })
    const stopSession = window.agentDesk.onSessionEvent((id, event) => {
      if (id === sessionId && event.kind === 'meta') void refresh()
    })
    return () => { alive.current = false; generation.current++; stopSettings(); stopSession() }
  }, [sessionId, refresh])
  const update = async (key: keyof MemoryPreferences, selection: string): Promise<void> => {
    if (!snapshot || mutation.current) return
    mutation.current = true
    setSaving(true)
    const token = ++generation.current
    const overrides: MemoryOverrides = { ...snapshot.overrides }
    if (selection === 'inherit') delete overrides[key]
    else overrides[key] = selection === 'on'
    try {
      const next = await window.agentDesk.updateTaskMemoryPreferences(sessionId, overrides)
      if (alive.current && token === generation.current) { setSnapshot(next); setError('') }
    } catch (failure) {
      if (alive.current) setError(String(failure instanceof Error ? failure.message : failure))
    } finally {
      mutation.current = false
      if (alive.current) { setSaving(false); void refresh() }
    }
  }
  return { snapshot, error, saving, refresh, update }
}

export default function TaskMemoryPreferences({ control }: { control: ReturnType<typeof useTaskMemoryPreferences> }): React.JSX.Element {
  return <section className="memory-group" aria-label="当前任务的记忆设置">
    <h4 className="settings-h3">当前任务的记忆设置</h4>
    <p className="field-hint">分别选择跟随全局、开启或关闭。关闭后保留历史记录、已有对话和当前任务专属记忆；后续检索与共享写入按此设置执行。</p>
    {(['useSharedMemory', 'contributeSharedMemory'] as const).map(key => <label className="field-label" key={key}>
      {key === 'useSharedMemory' ? '使用共享记忆' : '贡献共享记忆'}
      <select className="input input-block" disabled={!control.snapshot || control.saving || control.snapshot.temporary}
        value={control.snapshot?.overrides[key] === undefined ? 'inherit' : control.snapshot.overrides[key] ? 'on' : 'off'}
        onChange={event => { void control.update(key, event.target.value) }}>
        <option value="inherit">跟随全局{control.snapshot ? `（${control.snapshot.defaults[key] ? '开启' : '关闭'}）` : ''}</option>
        <option value="on">当前任务开启</option><option value="off">当前任务关闭</option>
      </select>
      {control.snapshot && <span className="field-hint">当前生效：{control.snapshot.effective[key] ? '开启' : '关闭'}</span>}
    </label>)}
    {control.snapshot?.temporary && <p className="field-hint">临时资料环境不使用或贡献共享记忆。</p>}
    {control.error && <div className="notice notice-error" role="alert">{control.error}</div>}
  </section>
}
