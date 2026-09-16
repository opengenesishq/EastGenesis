import { act } from 'react'
import { createRoot } from 'react-dom/client'
import SessionModelPicker from '../src/renderer/src/components/composer/SessionModelPicker'
import { useStore, type SessionState } from '../src/renderer/src/store'
import type { ProviderView, SessionMeta } from '../src/shared/types'
import type { SessionRoutingControl } from '../src/shared/session-routing-control-types'

const fixtureWindow = window as typeof window & {
  IS_REACT_ACT_ENVIRONMENT: boolean
  runSessionRoutingControlHarness: () => Promise<{ id: string; status: 'passed' }[]>
}
fixtureWindow.IS_REACT_ACT_ENVIRONMENT = true

function session(id: string, extra: Partial<SessionMeta> = {}): SessionState {
  return { meta: { id, title: id, model: 'auto', providerId: 'one', engine: 'openai', routingScope: 'global', status: 'idle',
    createdAt: 1, cwd: '/fixture', costUsd: 0, contextTokens: 0, taskStrategy: 'view', permissionMode: 'default',
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, ...extra },
    pendingPermissions: [], runningTools: {} } as SessionState
}
const providers = [
  { id: 'one', name: 'First connection', engine: 'openai', ready: true, models: ['one-small', 'one-large'] },
  { id: 'two', name: 'Second connection', engine: 'openai', ready: true, models: ['two-fast', 'two-balanced'] },
  { id: 'other-engine', name: 'Different executor', engine: 'anthropic', ready: true, models: ['other-model'] },
  { id: 'unavailable', name: 'Not ready', engine: 'openai', ready: false, models: ['unavailable-model'] }
] as ProviderView[]
function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

fixtureWindow.runSessionRoutingControlHarness = async () => {
  const checks: { id: string; status: 'passed' }[] = []
  const passed = (id: string) => checks.push({ id, status: 'passed' })
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(message) }
  const container = document.getElementById('root')!
  const root = createRoot(container)
  const originalState = useStore.getState()
  const originalAgentDesk = window.agentDesk
  const calls: { sessionId: string; control: SessionRoutingControl }[] = []
  const syncCalls: string[] = []
  let save: (id: string, control: SessionRoutingControl) => Promise<void> = async () => {}
  let sync: (id: string) => Promise<boolean> = async () => true
  const q = <T extends HTMLElement = HTMLElement,>(selector: string, index = 0): T => {
    const node = container.querySelectorAll<T>(selector)[index]
    assert(node, `missing element: ${selector} [${index}]`)
    return node
  }
  const select = async (selector: string, value: string, index = 0) => {
    const node = q<HTMLSelectElement>(selector, index)
    await act(async () => { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })) })
  }
  const apply = () => q<HTMLButtonElement>('[data-session-model-picker] > button.btn-primary')
  const clickApply = async () => { await act(async () => apply().click()) }
  const render = async (id: string) => { await act(async () => root.render(<SessionModelPicker sessionId={id} onClose={() => {}} />)) }
  const setSessions = async (sessions: Record<string, SessionState>) => { await act(async () => useStore.setState({ sessions })) }
  const locked = (providerId = 'two', model = 'two-fast'): SessionRoutingControl => ({ kind: 'locked', target: { providerId, model } })
  try {
    window.agentDesk = { ...originalAgentDesk,
      setRoutingControl: async (id: string, control: SessionRoutingControl) => {
        calls.push({ sessionId: id, control: structuredClone(control) })
        return save(id, control)
      }
    } as typeof window.agentDesk
    useStore.setState({ providers, settings: { ...originalState.settings, language: 'zh' }, sessions: { a: session('a'), b: session('b') },
      syncSession: async id => { syncCalls.push(id); return sync(id) } })
    await render('a')
    assert(q<HTMLSelectElement>('[data-session-routing-mode]').options.length === 3, 'three controls missing')
    assert(q<HTMLSelectElement>('[data-session-routing-mode]').value === 'auto', 'legacy global auto did not restore')
    assert(q<HTMLSelectElement>('[data-session-routing-scope]').value === '', 'global scope missing')
    assert(apply().disabled && calls.length === 0, 'opening must not change routing')
    await select('[data-session-routing-scope]', 'two')
    await clickApply()
    assert(JSON.stringify(calls.at(-1)) === JSON.stringify({ sessionId: 'a', control: { kind: 'auto', scope: { kind: 'provider', providerId: 'two' } } }), 'provider auto save lost scope')
    passed('three-modes-and-provider-auto-preserve-session-scoped-payload')

    await select('[data-session-routing-mode]', 'locked')
    const options = q<HTMLSelectElement>('[data-session-routing-provider]').options
    assert([...options].find(option => option.value === 'other-engine')?.disabled, 'incompatible executor available')
    assert([...options].find(option => option.value === 'unavailable')?.disabled, 'unready connection available')
    await select('[data-session-routing-provider]', 'two')
    assert(q<HTMLSelectElement>('[data-session-routing-model]').value === '', 'changing connection retained another connection model')
    await select('[data-session-routing-model]', 'two-fast')
    await clickApply()
    assert(JSON.stringify(calls.at(-1)?.control) === JSON.stringify(locked()), 'locked target lost cross-connection selection')
    passed('locked-selects-compatible-cross-connection-target-without-silent-fallback')

    await select('[data-session-routing-mode]', 'preferred')
    await select('[data-session-routing-provider]', 'one')
    await select('[data-session-routing-model]', 'one-large')
    await act(async () => q<HTMLButtonElement>('[data-session-routing-add-alternative]').click())
    await select('[data-session-routing-provider]', 'two', 1)
    await select('[data-session-routing-model]', 'two-balanced', 1)
    await select('[data-session-routing-failure]', 'retry_allowed_targets')
    const maxAttempts = [...container.querySelectorAll<HTMLSelectElement>('select')].find(node => node.parentElement?.textContent?.startsWith('最多追加尝试'))!
    await act(async () => { maxAttempts.value = '2'; maxAttempts.dispatchEvent(new Event('change', { bubbles: true })) })
    const auth = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(node => node.parentElement?.textContent === '确认鉴权失败')!
    await act(async () => auth.click())
    const preferred: SessionRoutingControl = { kind: 'preferred', primary: { providerId: 'one', model: 'one-large' },
      alternatives: [{ providerId: 'two', model: 'two-balanced' }], failure: { kind: 'retry_allowed_targets', maxAdditionalAttempts: 2, retryOn: ['rate_limited'] } }
    const pending = deferred()
    save = () => pending.promise
    await clickApply()
    assert(JSON.stringify(calls.at(-1)?.control) === JSON.stringify(preferred), 'preferred fallback authorization payload changed')
    assert(apply().disabled && q<HTMLFieldSetElement>('.session-routing-fields').disabled, 'saving must disable repeated changes')
    await clickApply()
    assert(calls.filter(call => call.control.kind === 'preferred').length === 1, 'duplicate save reached IPC')
    await act(async () => pending.reject(new Error('fixture rejected: preferred target unavailable')))
    assert(container.querySelector('[role="alert"]')?.textContent?.includes('fixture rejected'), 'save failure missing')
    assert(q<HTMLSelectElement>('[data-session-routing-mode]').value === 'preferred', 'failed save discarded preferred input')
    assert(q<HTMLSelectElement>('[data-session-routing-model]', 1).value === 'two-balanced', 'failed save discarded alternative')
    assert(q<HTMLSelectElement>('[data-session-routing-failure]').value === 'retry_allowed_targets', 'failed save discarded failure mode')
    passed('preferred-alternatives-retry-count-and-categories-survive-failed-save')

    await setSessions({ a: session('a', { routingControl: { kind: 'auto', scope: { kind: 'global' } } }), b: session('b') })
    await select('[data-session-routing-mode]', 'locked')
    await select('[data-session-routing-provider]', 'two')
    await select('[data-session-routing-model]', 'two-fast')
    await setSessions({ a: session('a', { costUsd: 0.01, routingControl: { kind: 'auto', scope: { kind: 'global' } } }), b: session('b') })
    assert(q<HTMLSelectElement>('[data-session-routing-mode]').value === 'locked', 'unrelated refreshed meta discarded unsaved routing input')
    assert(q<HTMLSelectElement>('[data-session-routing-model]').value === 'two-fast', 'unrelated refreshed meta discarded selected model')
    passed('equivalent-routing-meta-refresh-keeps-unsaved-input')

    const handoff = { artifacts: [], facts: [], failures: [] }
    await setSessions({ a: session('a', { model: 'one-small', routingScope: 'fixed', routingControl: locked('one', 'one-small'),
      modelChange: { state: 'prepared', digest: 'prepared', to: { providerId: 'two', model: 'two-fast', routingScope: 'fixed', routingControl: locked() }, handoff } as SessionMeta['modelChange'] }), b: session('b') })
    assert(q<HTMLFieldSetElement>('.session-routing-fields').disabled, 'prepared state permits changing the pending decision')
    assert(q<HTMLSelectElement>('[data-session-routing-provider]').value === 'two', 'prepared state did not restore pending target')
    assert(!apply().disabled, 'prepared state cannot retry same decision')
    save = async () => {}
    await clickApply()
    assert(JSON.stringify(calls.at(-1)?.control) === JSON.stringify(locked()), 'prepared retry did not submit exact pending control')
    passed('prepared-switch-freezes-fields-and-retries-exact-pending-decision')

    for (const outcome of ['resolve', 'reject'] as const) {
      await setSessions({ a: session('a'), b: session('b', { model: 'one-small', routingScope: 'fixed' }) })
      await render('a')
      await select('[data-session-routing-mode]', 'locked')
      await select('[data-session-routing-provider]', 'two')
      await select('[data-session-routing-model]', 'two-fast')
      const late = deferred()
      save = () => late.promise
      await clickApply()
      await render('b')
      assert(q<HTMLSelectElement>('[data-session-routing-model]').value === 'one-small', 'new session inherited old input')
      await act(async () => outcome === 'resolve' ? late.resolve() : late.reject(new Error('old session failure')))
      assert(q<HTMLSelectElement>('[data-session-routing-model]').value === 'one-small', 'late save replaced another session target')
      assert(!container.querySelector('[role="alert"]') && !container.textContent?.includes('后续模型已保存'), 'late save leaked status into another session')
      assert(calls.at(-1)?.sessionId === 'a', 'switching view changed IPC session identity')
      passed(`late-${outcome}-cannot-change-another-session-input-or-notice`)
    }

    await setSessions({ a: session('a', { status: 'running' }) })
    await render('a')
    const count = calls.length
    assert(q<HTMLFieldSetElement>('.session-routing-fields').disabled && apply().disabled, 'running task can change model')
    await clickApply()
    assert(calls.length === count, 'running task called model mutation IPC')
    passed('running-task-cannot-change-the-in-flight-request')

    await setSessions({ a: session('a', { routingControl: { kind: 'preferred', primary: { providerId: 'missing', model: 'removed-model' },
      alternatives: [], failure: { kind: 'pause' } } }) })
    assert(q<HTMLSelectElement>('[data-session-routing-provider]').value === 'missing', 'missing saved connection silently replaced')
    assert(q<HTMLSelectElement>('[data-session-routing-model]').value === 'removed-model', 'missing saved model silently replaced')
    assert(q<HTMLSelectElement>('[data-session-routing-provider]').selectedOptions[0].disabled, 'missing saved connection not disclosed')
    passed('removed-saved-target-remains-visible-without-substitution')
    return checks
  } finally {
    await act(async () => root.unmount())
    useStore.setState(originalState, true)
    window.agentDesk = originalAgentDesk
  }
}
