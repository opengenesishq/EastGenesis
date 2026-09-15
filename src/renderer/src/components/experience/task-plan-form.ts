import type { Dispatch, SetStateAction } from 'react'
import type { TaskPlanDraftInput, TaskPlanRiskLevel, TaskPlanStepInput, TaskPlanVersion } from '../../../../shared/types'

type StepContractFields = Pick<TaskPlanStepInput, 'role' | 'executionRole' | 'workItemType' | 'acceptanceSpec'>

export interface StepForm extends StepContractFields {
  key: string
  id: string
  title: string
  description: string
  dependsOn: string
  expectedArtifacts: string
  dataEgress: string
  estimatedCostUsd: string
  riskLevel: TaskPlanRiskLevel
}

export interface PlanForm {
  objective: string
  steps: StepForm[]
  expectedArtifacts: string
  dataEgress: string
  estimatedCostUsd: string
  riskLevel: TaskPlanRiskLevel
  acceptanceCriteria: string
  changeReason: string
}

export type PlanFormSetter = Dispatch<SetStateAction<PlanForm>>

let stepKey = 0

export function emptyPlanForm(): PlanForm {
  return {
    objective: '',
    steps: [newPlanStep(1)],
    expectedArtifacts: '',
    dataEgress: '',
    estimatedCostUsd: '',
    riskLevel: 'medium',
    acceptanceCriteria: '',
    changeReason: ''
  }
}

export function newPlanStep(index: number): StepForm {
  stepKey += 1
  return {
    key: `plan-step-${stepKey}`,
    id: `step-${index}`,
    title: '',
    description: '',
    dependsOn: '',
    expectedArtifacts: '',
    dataEgress: '',
    estimatedCostUsd: '',
    riskLevel: 'medium'
  }
}

export function planFormFromVersion(version: TaskPlanVersion): PlanForm {
  return {
    objective: version.objective,
    steps: version.steps.map((step) => ({
      key: `plan-step-${++stepKey}`,
      id: step.id,
      title: step.title,
      description: step.description,
      ...copyStepContractFields(step),
      dependsOn: step.dependsOn.join('\n'),
      expectedArtifacts: step.expectedArtifacts.join('\n'),
      dataEgress: step.dataEgress.join('\n'),
      estimatedCostUsd: step.estimatedCostUsd === null ? '' : String(step.estimatedCostUsd),
      riskLevel: step.riskLevel
    })),
    expectedArtifacts: version.expectedArtifacts.join('\n'),
    dataEgress: version.dataEgress.join('\n'),
    estimatedCostUsd: version.estimatedCostUsd === null ? '' : String(version.estimatedCostUsd),
    riskLevel: version.riskLevel,
    acceptanceCriteria: version.acceptanceCriteria.join('\n'),
    changeReason: ''
  }
}

export function taskPlanDraftFromForm(form: PlanForm): TaskPlanDraftInput {
  return {
    objective: form.objective,
    steps: form.steps.map((step) => ({
      id: step.id,
      title: step.title,
      description: step.description,
      ...copyStepContractFields(step),
      dependsOn: lineList(step.dependsOn),
      expectedArtifacts: lineList(step.expectedArtifacts),
      dataEgress: lineList(step.dataEgress),
      estimatedCostUsd: step.estimatedCostUsd.trim() ? Number(step.estimatedCostUsd) : null,
      riskLevel: step.riskLevel
    })),
    expectedArtifacts: lineList(form.expectedArtifacts),
    dataEgress: lineList(form.dataEgress),
    estimatedCostUsd: form.estimatedCostUsd.trim() ? Number(form.estimatedCostUsd) : null,
    riskLevel: form.riskLevel,
    acceptanceCriteria: lineList(form.acceptanceCriteria),
    changeReason: form.changeReason
  }
}

// Keep structured fields on their own row, including when users reorder,
// remove or rename steps. Clone acceptance entries so editing a form or draft
// cannot mutate the stored version or another conversion's result.
function copyStepContractFields(step: StepContractFields): StepContractFields {
  return {
    ...(step.role === undefined ? {} : { role: step.role }),
    ...(step.executionRole === undefined ? {} : { executionRole: step.executionRole }),
    ...(step.workItemType === undefined ? {} : { workItemType: step.workItemType }),
    ...(step.acceptanceSpec === undefined ? {} : { acceptanceSpec: step.acceptanceSpec.map((entry) => ({ ...entry })) })
  }
}

export function updatePlanStep(setForm: PlanFormSetter, index: number, patch: Partial<StepForm>): void {
  setForm((form) => ({
    ...form,
    steps: form.steps.map((step, itemIndex) => itemIndex === index ? { ...step, ...patch } : step)
  }))
}

export function lineList(value: string): string[] {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
}
