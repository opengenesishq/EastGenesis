import type { WorkItemType } from '../../shared/project-workspace-types'
import type { TaskPlanDraftInput, TaskPlanInstitutionResponsibility, TaskPlanStepInput, TaskPlanVersion } from '../../shared/task-plan-types'
import { projectInstitutionTemplate, type ProjectInstitutionTemplateRef } from '../../shared/project-institution-template'

const INSTITUTION_BY_WORK_TYPE: Record<WorkItemType, string> = {
  research: 'hanlinyuan', analysis: 'hanlinyuan',
  writing: 'libu_ritual', design: 'libu_ritual', documentation: 'libu_ritual', delivery: 'libu_ritual',
  coding: 'gongbu', testing: 'duchayuan', review: 'duchayuan',
  planning: 'neige', custom: 'neige', operations: 'bingbu'
}

/** Enrich only the steps already planned. Never creates an Agent, route or extra approval. */
export function bindTaskPlanInstitutions(draft: TaskPlanDraftInput, ref?: ProjectInstitutionTemplateRef): TaskPlanDraftInput {
  const { institutionTemplate: _untrustedTemplate, ...plain } = draft
  const steps = plain.steps.map(({ institution: _untrustedInstitution, ...step }) => step)
  const template = projectInstitutionTemplate(ref)
  if (template.ref.templateId === 'legacy-compatible') return { ...plain, steps }
  return {
    ...plain,
    institutionTemplate: { ...template.ref },
    steps: steps.map((step) => {
      const workItemType = institutionWorkItemType(step)
      const role = template.roles.find((entry) => entry.id === INSTITUTION_BY_WORK_TYPE[workItemType])!
      return { ...step, workItemType, institution: { id: role.id, label: role.name, duty: role.duty } }
    })
  }
}

function institutionWorkItemType(step: TaskPlanStepInput): WorkItemType {
  if (step.workItemType) return step.workItemType
  const byRole: Record<string, WorkItemType> = { research: 'research', build: 'coding', document: 'documentation', verify: 'testing' }
  if (step.role && byRole[step.role]) return byRole[step.role]
  if (step.executionRole === 'frontend' || step.executionRole === 'backend') return 'coding'
  if (step.executionRole === 'qa') return 'testing'
  if (step.executionRole === 'review') return 'review'
  if (step.executionRole === 'docs') return 'documentation'
  if (step.executionRole === 'devops') return 'operations'
  // A fallback for the existing general executor: use this step's own work,
  // never the global objective (which may mention every department's output).
  const text = `${step.title}\n${step.description ?? ''}`
  if (/调研|研究|检索|搜集|来源|数据分析|research|investigat|analy[sz]/i.test(text)) return 'research'
  if (/代码|编程|修复|软件|接口|建模|implement|\bcode\b|\bapi\b|\bbug\b/i.test(text)) return 'coding'
  if (/文稿|文档|汇报|演示|写作|设计|报告|presentation|document|\breport\b|\bdesign\b|\bwrite\b/i.test(text)) return 'writing'
  if (/验证|检查|复核|测试|审查|\btest\b|\breview\b|\bverify\b/i.test(text)) return 'review'
  return 'custom'
}

export function institutionResponsibilityLines(
  version: Pick<TaskPlanVersion, 'institutionTemplate'>,
  institution?: TaskPlanInstitutionResponsibility
): string[] {
  if (!version.institutionTemplate || !institution) return []
  return [
    `机构职责：${institution.label}（${institution.id}）`,
    `模板：${version.institutionTemplate.templateId}@${version.institutionTemplate.templateVersion}`,
    `职责范围：${institution.duty}`,
    '机构职责不代表已分派 Agent，也不新增工具、数据或审批权限。'
  ]
}
