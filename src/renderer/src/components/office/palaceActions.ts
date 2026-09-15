import type { TaskPlanStateView, WorkItem } from '../../../../shared/types'

export const PALACE_ACTIONS = [
  { id: 'edict', label: '下旨', labelEn: 'Give an instruction' },
  { id: 'court', label: '上朝', labelEn: 'Court overview' },
  { id: 'approve', label: '批奏折', labelEn: 'Review approvals' },
  { id: 'audience', label: '单独召见', labelEn: 'Meet an Agent' },
  { id: 'council', label: '召集议事', labelEn: 'Council review' },
  { id: 'patrol', label: '巡视六部', labelEn: 'Inspect ministries' },
  { id: 'inspect', label: '微服私访', labelEn: 'Inspect source records' },
  { id: 'urgent', label: '急奏', labelEn: 'Urgent reports' },
  { id: 'study', label: '御书房办公', labelEn: 'Study workspace' },
  { id: 'desk', label: '御案', labelEn: 'Command desk' }
] as const

export type PalaceAction = typeof PALACE_ACTIONS[number]['id']
export interface PalaceActionContext { sessionId?: string; projectId?: string; workItemId?: string; roleId?: string }

/** Frozen approvals identify institutions; task prose and scene costumes cannot assign an owner. */
export function palaceInstitutionWorkItems(roleId: string, items: readonly WorkItem[], plans: readonly TaskPlanStateView[]): WorkItem[] {
  const institutions = new Map<string, string>()
  for (const plan of plans) {
    for (const event of plan.approvalEvents) {
      if (event.kind !== 'approved' || event.projection?.mode !== 'canonical') continue
      const version = plan.versions.find((entry) => entry.version === event.version && entry.digest === event.digest)
      if (!version?.institutionTemplate) continue
      for (const receipt of event.projection.steps) {
        const institution = version.steps.find((step) => step.id === receipt.stepId)?.institution
        if (institution) institutions.set(receipt.workItemId, institution.id)
      }
    }
  }
  return items.filter((item) => roleId === 'all' || (institutions.get(item.id) ?? item.role) === roleId)
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
}
