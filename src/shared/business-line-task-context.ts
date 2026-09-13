import type { TaskPlanDraftInput } from './task-plan-types'
import type { BusinessLineDefinition } from './business-line-types'

/** The same business instructions and reviewable plan apply at every task entry point. */
export function businessLineTaskPlan(line: BusinessLineDefinition, prompt: string): TaskPlanDraftInput {
  const steps = line.workflow.length ? line.workflow : ['完成任务并核对成果']
  return {
    objective: prompt.trim(), source: 'manual', expectedArtifacts: line.deliverables,
    acceptanceCriteria: line.acceptanceCriteria ?? [],
    steps: steps.map((title, index) => ({ id: `step-${index + 1}`, title, dependsOn: index ? [`step-${index}`] : [] }))
  }
}

export function businessLineTaskPrompt(line: BusinessLineDefinition, prompt: string): string {
  return [prompt.trim(), `业务线：${line.name}`, line.objective && `业务目标：${line.objective}`,
    line.roleInstructions && `角色与工作要求：\n${line.roleInstructions}`,
    line.workflow.length && `工作流程：\n${line.workflow.map((step, index) => `${index + 1}. ${step}`).join('\n')}`,
    line.deliverables.length && `预期成果：\n${line.deliverables.map((item) => `- ${item}`).join('\n')}`,
    line.acceptanceCriteria?.length && `待核验的验收标准（需用成果证据逐项核对，不可无证据宣称通过）：\n${line.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`
  ].filter(Boolean).join('\n\n')
}
