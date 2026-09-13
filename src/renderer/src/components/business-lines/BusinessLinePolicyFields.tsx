import type { BusinessLineDefinition } from '../../../../shared/business-line-types'
import BusinessLineSurfaceFields from './BusinessLineSurfaceFields'

export default function BusinessLinePolicyFields({ draft, onChange, zh }: { draft: BusinessLineDefinition; onChange: (draft: BusinessLineDefinition) => void; zh: boolean }): React.JSX.Element {
  const label = zh
    ? { budget: '每任务预算上限（USD，留空继承）', capabilities: '所需模型能力', tools: '工具调用', vision: '图像理解', role: '角色与工作要求', criteria: '验收标准（每行一项）', scope: '工具范围', inherit: '继承任务默认策略', view: '查看：只读工具', plan: '规划：只读与计划', execute: '执行：按既有权限执行' }
    : { budget: 'Task budget limit (USD; empty inherits)', capabilities: 'Required model capabilities', tools: 'Tool calling', vision: 'Image understanding', role: 'Role instructions', criteria: 'Acceptance criteria (one per line)', scope: 'Tool scope', inherit: 'Inherit task strategy', view: 'View: read-only tools', plan: 'Plan: read and plan', execute: 'Execute: existing permission rules' }
  const capabilities = draft.requiredCapabilities ?? []
  return <>
    <BusinessLineSurfaceFields draft={draft} onChange={onChange} zh={zh} />
    <label>{label.budget}<input className="input" name="businessLineBudget" type="number" min="0.001" max="1000000" step="any" value={draft.taskBudgetUsd ?? ''} onChange={(event) => onChange({ ...draft, taskBudgetUsd: event.target.value ? Number(event.target.value) : undefined })} /></label>
    <fieldset className="business-line-capabilities"><legend>{label.capabilities}</legend>{(['tools', 'vision'] as const).map((value) => <label key={value}><input type="checkbox" data-business-capability={value} checked={capabilities.includes(value)} onChange={(event) => onChange({ ...draft, requiredCapabilities: event.target.checked ? [...capabilities, value] : capabilities.filter((item) => item !== value) })} />{label[value]}</label>)}</fieldset>
    <label>{label.role}<textarea className="input" name="businessLineRole" rows={3} maxLength={8000} value={draft.roleInstructions ?? ''} onChange={(event) => onChange({ ...draft, roleInstructions: event.target.value })} /></label>
    <label>{label.criteria}<textarea className="input" name="businessLineAcceptance" rows={3} value={(draft.acceptanceCriteria ?? []).join('\n')} onChange={(event) => onChange({ ...draft, acceptanceCriteria: event.target.value.split('\n') })} /></label>
    <label>{label.scope}<select className="input" name="businessLineToolScope" value={draft.toolScope ?? ''} onChange={(event) => onChange({ ...draft, toolScope: event.target.value as BusinessLineDefinition['toolScope'] || undefined })}><option value="">{label.inherit}</option>{(['view', 'plan', 'execute'] as const).map((value) => <option value={value} key={value}>{label[value]}</option>)}</select></label>
  </>
}
