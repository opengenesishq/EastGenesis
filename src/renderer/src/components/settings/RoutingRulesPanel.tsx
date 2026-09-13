import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store'
import { getBusinessLines } from '../../../../shared/business-line-types'
import type { RoutingRuleApi, RoutingRuleDraftV1 } from '../../../../shared/routing-policy-types'
import RoutingRuleEditorShell from './routing-rules/RoutingRuleEditorShell'
import RoutingRuleForm from './routing-rules/RoutingRuleForm'
import { createRoutingControllerRunner } from './routing-rules/routing-controller-runner'
import type { RoutingControllerState } from './routing-rules/routing-controller-types'
import { createRoutingControllerState, routingOutcomeUnknown } from './routing-rules/routing-controller-state'
import { initialRoutingPreviewContext, resolvePanelLegacy, reviewedPanelDraft } from './routing-rules/routing-panel-state'
import RoutingPanelContext from './routing-rules/RoutingPanelContext'
import RoutingPanelComparison from './routing-rules/RoutingPanelComparison'
import RoutingPreviewRuleSources from './routing-rules/RoutingPreviewRuleSources'
import { routingProviderOptions } from './routing-rules/routing-provider-options'
import './routing-rules/routing-panel.css'

export default function RoutingRulesPanel(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const activeId = useStore((s) => s.activeId)
  const activeSession = useStore((s) => activeId ? s.sessions[activeId] : undefined)
  const active = activeSession?.meta
  const activePrompt = [...(activeSession?.items ?? [])].reverse().find((item) => item.kind === 'user')
  const businessLineId = settings.selectedBusinessLineId ?? 'assistant'
  const [state, setState] = useState<RoutingControllerState>(() => ({ ...createRoutingControllerState(),
    context: initialRoutingPreviewContext(active?.id, businessLineId, activePrompt?.kind === 'user' ? activePrompt.text : '') }))
  const retained = useRef(state)
  const runnerRef = useRef<ReturnType<typeof createRoutingControllerRunner> | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  useEffect(() => {
    const api: RoutingRuleApi = {
      getRoutingRuleSet: () => window.agentDesk.getRoutingRuleSet(),
      previewRoutingRuleSet: (input) => window.agentDesk.previewRoutingRuleSet(input),
      saveRoutingRuleSet: (input) => window.agentDesk.saveRoutingRuleSet(input)
    }
    const runner = createRoutingControllerRunner({ api, initialState: retained.current, onStateChange: setState })
    runnerRef.current = runner
    setState(runner.getSnapshot())
    void runner.read()
    return () => {
      retained.current = runner.dispose()
      runnerRef.current = null
    }
  }, [])
  const reread = (): void => { setReviewOpen(true); void runnerRef.current?.read() }
  const read = state.read
  const draft = state.draft
  if (!read || !draft) return <RoutingPanelReadState state={state} onReread={reread} />
  const lines = getBusinessLines(settings).map((line) => ({ id: line.id, name: line.name, enabled: line.enabled }))
  const providerOptions = routingProviderOptions(providers)
  const providerName = (id: string): string => providers.find((provider) => provider.id === id)?.name ?? id
  const lineName = (id: string): string => lines.find((line) => line.id === id)?.name ?? id
  const selected = draft.rules.find((rule) => rule.id === state.selectedRuleId) ?? draft.rules[0]
  const limits = { targets: 8, keywords: 12, retries: 8, maxPriority: 1000 }
  const edit = selected ? <RoutingRuleForm draft={selected} providers={providerOptions} businessLines={lines} limits={limits} diagnostics={state.preview?.diagnostics}
    onChange={(next) => runnerRef.current?.editDraft({ ...draft, rules: draft.rules.map((rule) => rule.id === next.id ? next : rule) })} /> : undefined
  const locked = Boolean(state.pending) || routingOutcomeUnknown(state) || read.mode === 'invalid_v1'
  const reviewed = (): void => {
    const result = reviewedPanelDraft(state)
    if (result.resolution) { runnerRef.current?.resolveComparison(result.resolution); setReviewOpen(false) }
  }
  return <div className="rr-editor" data-routing-panel>
    <RoutingPanelContext context={state.context} active={active} lines={lines} defaultLineId={businessLineId} disabled={locked || Boolean(state.comparison)}
      onChange={(context) => runnerRef.current?.setContext(context)} />
    {state.error && <div className="rr-panel-error" role="alert" data-routing-panel-error={state.error.kind}>
      <p>{state.error.kind === 'save_outcome_unknown' ? '尚不能确认保存结果，请重新读取并核对。' : state.error.message}</p>
      <button type="button" disabled={Boolean(state.pending)} onClick={reread}>重新读取规则</button>
    </div>}
    {state.comparison && (reviewOpen || state.comparison.kind !== 'conflict') && <RoutingPanelComparison state={state} providerName={providerName} lineName={lineName}
      onAdopt={() => { runnerRef.current?.resolveComparison({ kind: 'adopt_latest' }); setReviewOpen(false) }} onKeepDraft={reviewed} onReread={reread} />}
    <RoutingRuleEditorShell read={read} draft={draft} selectedRuleId={selected?.id ?? null} businessLines={lines} dirty={state.dirty}
    busy={state.pending?.kind === 'save' ? 'saving' : state.pending?.kind === 'preview' ? 'previewing' : state.pending?.kind === 'read' ? 'loading' : undefined}
    migration={state.migration} lastSave={state.lastSave} diagnostics={state.preview?.diagnostics} editor={edit}
    preview={state.preview && <section data-routing-panel-preview>
      <p role="status">{state.preview.status === 'ready' && state.preview.initialTarget
        ? `初始目标：${providerName(state.preview.initialTarget.providerId)} / ${state.preview.initialTarget.model}` : '当前规则不可执行'}</p>
      <RoutingPreviewRuleSources preview={state.preview} rules={draft.rules} />
    </section>}
    onSelectRule={(id) => runnerRef.current?.selectRule(id)}
    onAddRule={() => {
      const rule: RoutingRuleDraftV1 = { id: `route-${crypto.randomUUID()}`, name: '', enabled: true, priority: draft.rules.length,
        scope: { kind: 'global' }, when: {}, selection: { kind: 'global_auto' }, strategy: 'balanced', failure: { kind: 'pause' }, expectedVersion: null }
      runnerRef.current?.editDraft({ ...draft, rules: [...draft.rules, rule] })
      runnerRef.current?.selectRule(rule.id)
    }}
    onRemoveRule={(id) => runnerRef.current?.editDraft({ ...draft, rules: draft.rules.filter((rule) => rule.id !== id) })}
    onResolveLegacy={(resolution) => { const migration = resolvePanelLegacy(state, resolution); if (migration) runnerRef.current?.editMigration(migration) }}
    onPreview={() => void runnerRef.current?.preview()} onSave={() => void runnerRef.current?.save()} onReviewConflict={() => setReviewOpen(true)} onReread={reread} />
  </div>
}

function RoutingPanelReadState({ state, onReread }: { state: RoutingControllerState; onReread(): void }): React.JSX.Element {
  const message = state.error?.message ?? (state.read?.mode === 'invalid_v1' ? state.read.diagnostics[0]?.message ?? '现有路由规则无法读取。' : undefined)
  return <section className="settings-section" data-routing-panel-state><h3 className="settings-h3">模型路由规则</h3>
    {message ? <><p className="settings-hint" role="alert">{message}</p><button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(state.pending)} onClick={onReread}>重新读取规则</button></> : <p className="settings-hint">正在读取版本化路由规则…</p>}
  </section>
}
