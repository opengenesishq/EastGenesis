import { useEffect, useRef, useState } from 'react'
import type { TaskBudgetView } from '../../../../shared/task-budget-types'
import './TaskBudgetSummary.css'

export default function TaskBudgetSummary({ sessionId, language }: { sessionId: string; language: 'zh' | 'en' }): React.JSX.Element {
  return <BoundTaskBudgetSummary key={sessionId} sessionId={sessionId} language={language} />
}

function BoundTaskBudgetSummary({ sessionId, language }: { sessionId: string; language: 'zh' | 'en' }): React.JSX.Element {
  const zh = language === 'zh'
  const [view, setView] = useState<TaskBudgetView>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const refreshRef = useRef<() => void>(() => {})
  useEffect(() => {
    let disposed = false, pending = false
    const refresh = async (): Promise<void> => {
      if (pending || document.hidden) return
      pending = true
      setBusy(true)
      try {
        const next = await window.agentDesk.getTaskBudget(sessionId)
        if (!disposed) { setView(next); setFailed(false) }
      } catch { if (!disposed) { setView(undefined); setFailed(true) } }
      finally { pending = false; if (!disposed) setBusy(false) }
    }
    const onVisible = (): void => { if (!document.hidden) void refresh() }
    refreshRef.current = () => { void refresh() }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 5000)
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener('focus', onVisible); document.removeEventListener('visibilitychange', onVisible) }
  }, [sessionId])
  const ready = view?.state === 'ready' && !failed
  const money = (value: number | undefined): string => value === undefined ? (zh ? '未知' : 'Unknown') :
    new Intl.NumberFormat(zh ? 'zh-CN' : 'en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value)
  const unresolved = (view?.uncertainCount ?? 0) + (view?.missingUsageRunCount ?? 0)
  const remaining = !ready || view.remainingState === 'unknown' ? (zh ? '待核对' : 'Needs reconciliation') :
    view.remainingState === 'unlimited' ? (zh ? '未设置上限' : 'No limit set') : money(view.remainingUsd)
  const frozen = ready && view.frozenRunLimitUsd !== undefined &&
    (view.goalLimitUsd === undefined || view.frozenRunLimitUsd < view.goalLimitUsd)
  return <details className="task-budget-summary no-drag" data-task-budget-session={sessionId}>
    <summary>
      <strong>{zh ? '目标预算' : 'Goal budget'}</strong>
      <span>{zh ? '可用' : 'Available'}：{ready || failed || view ? remaining : (zh ? '读取中…' : 'Loading…')}</span>
      {ready && unresolved > 0 && <span className="task-budget-warning">{zh ? `${unresolved} 项费用待核对` : `${unresolved} costs unresolved`}</span>}
    </summary>
    <div className="task-budget-content">
      <header>
        <span>{ready ? view.goal?.title : zh ? '当前目标的共享预算' : 'Shared budget for the current goal'}</span>
        <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => refreshRef.current()}>{zh ? '刷新' : 'Refresh'}</button>
      </header>
      {ready ? <>
        <dl>
          <div><dt>{zh ? '已记录费用' : 'Recorded spending'}</dt><dd>{money(view.recordedSpentUsd)}</dd></div>
          <div><dt>{zh ? '执行中预留' : 'In-flight reservations'}</dt><dd>{(view.unpricedReservedCount ?? 0) > 0 ? (zh ? '金额未完全确定' : 'Amount partly unknown') : money(view.reservedUsd)}
            <small>{zh ? `${view.reservedCount ?? 0} 笔` : `${view.reservedCount ?? 0} requests`}
              {(view.unpricedReservedCount ?? 0) > 0 && (zh ? `；已知 ${money(view.reservedUsd)}，${view.unpricedReservedCount} 笔未定价` : `; known ${money(view.reservedUsd)}, ${view.unpricedReservedCount} unpriced`)}</small></dd></div>
          <div><dt>{zh ? '费用待核对' : 'Unresolved costs'}</dt><dd>{unresolved ? (zh ? `${unresolved} 项 · 金额未知` : `${unresolved} items · amount unknown`) : (zh ? '无' : 'None')}</dd></div>
          <div><dt>{zh ? '扣除预留后可用' : 'Available after reservations'}</dt><dd>{remaining}</dd></div>
        </dl>
        <p>{zh ? '本目标的所有分工、重试与媒体请求共用此预算。' : 'This budget is shared by all work, retries and media requests in this goal.'}
          {' '}{zh ? '当前上限：' : 'Current limit: '}{view.limitUsd === undefined ? (zh ? '未设置' : 'Not set') : money(view.limitUsd)}
          {frozen && (zh ? '；本次运行沿用启动时的较低上限。' : '; this run retains its lower original cap.')}</p>
        {unresolved > 0 && <p className="task-budget-warning">{zh ? '待核对记录不会按零费用释放额度。' : 'Unresolved records do not release their allowance as zero-cost requests.'}
          {(view.uncertainHeldUsd ?? 0) > 0 && (zh ? ` 待核对记录保留的已知金额/估算：${money(view.uncertainHeldUsd)}。` : ` Known/estimated amount retained: ${money(view.uncertainHeldUsd)}.`)}</p>}
        <p className="task-budget-note">{zh ? '金额来自本地费用与请求保留账本；供应商账户余额、会话及月度限制另行核对。' : 'Amounts come from local cost and reservation records. Provider balances, session and monthly limits are checked separately.'}</p>
      </> : <p role={failed || view?.state === 'unavailable' ? 'alert' : undefined}>
        {view?.state === 'unbound' ? (zh ? '当前会话尚未关联目标。' : 'This session is not linked to a goal.') :
          failed || view?.state === 'unavailable' ? (zh ? '预算记录暂时无法核对，费用和可用额度均未确定。请刷新重试。' : 'Budget records could not be verified. Costs and available allowance are unknown. Refresh to retry.') :
            (zh ? '正在读取预算记录…' : 'Reading budget records…')}
      </p>}
    </div>
  </details>
}
