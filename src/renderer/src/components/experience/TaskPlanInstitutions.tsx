import type { TaskPlanVersion } from '../../../../shared/task-plan-types'
import { useStore } from '../../store'

export default function TaskPlanInstitutions({ version }: { version: TaskPlanVersion }): React.JSX.Element | null {
  const english = useStore((state) => state.settings.language) === 'en'
  if (!version.institutionTemplate) return null
  return <details className="task-plan-review" data-task-plan-institutions={version.institutionTemplate.templateId}>
    <summary>{english ? 'Institution responsibilities' : '机构职责建议'} · v{version.institutionTemplate.templateVersion}</summary>
    <p>{english
      ? 'These responsibilities belong to this plan version. Agent assignment and progress are shown in execution records; existing permissions still apply.'
      : '这些职责随当前计划版本保存。实际 Agent 分派与进度以执行记录为准，继续使用已有权限。'}</p>
    <ol>{version.steps.map((step) => <li key={step.id}>
      <strong>{step.institution?.label} · {step.title}</strong>
      <p>{step.institution?.duty}</p>
    </li>)}</ol>
  </details>
}
