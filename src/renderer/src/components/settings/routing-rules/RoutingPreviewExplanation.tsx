import type { RoutingRulePreviewResult, RoutingTargetRef } from '../../../../../shared/routing-policy-types'
import { FAILURE_LABELS, SELECTION_LABELS, STRATEGY_LABELS, TASK_LABELS } from './routing-form-options'

export default function RoutingPreviewExplanation({ preview, providerName }: {
  preview: RoutingRulePreviewResult
  providerName(id: string): string
}): React.JSX.Element {
  const targetName = (target: RoutingTargetRef): string => `${providerName(target.providerId)} / ${target.model}`
  const policy = preview.effectivePolicy
  return <section className="rr-preview-explanation" data-routing-preview-explanation>
    <h4>为什么这样选择</h4>
    {policy && <dl className="rr-preview-policy">
      <dt>选择范围</dt><dd>{SELECTION_LABELS[policy.selection.kind]}</dd>
      <dt>选择偏好</dt><dd>{STRATEGY_LABELS[policy.strategy]}</dd>
      <dt>失败处理</dt><dd>{FAILURE_LABELS[policy.failure.kind]}</dd>
    </dl>}
    {preview.explanation && <>
      <p data-routing-preview-selection-reason>{preview.explanation.selectionReason}</p>
      <p>识别用途：{preview.explanation.taskKinds.map((kind) => TASK_LABELS[kind]).join('、') || '通用任务'}</p>
      {preview.explanation.warnings.map((warning, index) => <p key={index} role="status">{warning}</p>)}
      <details data-routing-preview-candidate-evidence>
        <summary>查看 {preview.explanation.candidates.length} 个合格模型的评分依据</summary>
        <p className="rr-hint">以下依据来自当前配置和已有运行记录。评分用于本次比较，不代表模型实测排名。</p>
        <ul>{preview.explanation.candidates.map((candidate) => <li key={`${candidate.target.providerId}:${candidate.target.model}`}>
          <strong>{targetName(candidate.target)}{candidate.selected ? ' · 本次选择' : ''}</strong>
          <p>{candidate.reasons.join('；')}</p>
          <p className="rr-hint">{candidate.pricingBasis === 'declared' ? '费用按已配置单价估算。' : '尚无已配置单价，费用为启发式估算。'}
            {candidate.acceptanceSamples === 0 ? ' 此目标没有任务验收样本。' : ` 已有 ${candidate.acceptanceSamples} 个任务验收样本。`}</p>
        </li>)}</ul>
      </details>
    </>}
    <h4>允许的失败备选</h4>
    {preview.allowedAlternatives.length ? <>
      <p className="rr-hint">{policy?.selection.kind === 'preferred' && policy.selection.alternativesOrder === 'configured'
        ? '按以下顺序切换模型，下一备选不可用时停止。' : '备选按系统评分排列。'}仅在规则允许的失败原因和重试次数内使用；不因检查通过自动派发。</p>
      <ol data-routing-preview-alternatives>{preview.allowedAlternatives.map((target) => <li key={`${target.providerId}:${target.model}`}>{targetName(target)}</li>)}</ol>
    </> : <p data-routing-preview-no-alternatives>{policy?.failure.kind === 'retry_same_target' ? '只在原目标重试，不切换模型。'
      : policy?.failure.kind === 'pause' ? '失败时暂停并提示，不自动切换模型。' : '本次没有允许的合格备选。'}</p>}
    {preview.excludedTargets.length > 0 && <details data-routing-preview-excluded>
      <summary>查看 {preview.excludedTargets.length} 个未参与模型及原因</summary>
      <ul>{preview.excludedTargets.map(({ target, diagnostics }, index) => <li key={`${target.providerId}:${target.model}:${index}`}>
        <strong>{targetName(target)}</strong>
        {diagnostics.map((diagnostic, at) => <p key={at}>{diagnostic.path === '$.selection' && diagnostic.code === 'HARD_CONSTRAINT_EXCLUDED'
          ? '不在当前任务指定范围与命中规则允许的候选范围内。' : diagnostic.code === 'TARGET_UNAVAILABLE'
            ? '此目标已不在当前厂商模型目录中。' : diagnostic.message}</p>)}
      </li>)}</ul>
    </details>}
  </section>
}
