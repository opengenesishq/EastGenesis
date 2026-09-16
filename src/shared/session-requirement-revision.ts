import type { AcceptanceSpec, Goal, GoalContract, WorkItem } from './project-workspace-types'
import { extractGoalRequestRequirements, type GoalRequestRequirement } from './goal-request-requirements'

export interface SessionRequirementRevisionIntent {
  schemaVersion: 1
  kind: 'revise_delivery_requirements'
  expectedGoalRevision: number
  expectedWorkItemRevision: number
}

export interface SessionRequirementRevisionReceipt {
  schemaVersion: 1
  sourceEventId: string
  goalRevision: number
  workItemRevision: number
  requirements: GoalRequestRequirement[]
}

export interface SessionRequirementRevisionInput {
  sessionId: string
  requestId: string
  messageId: string
  projectId: string
  workItemId: string
  text: string
  payloadDigest: string
  intent: SessionRequirementRevisionIntent
}

export interface SessionRequirementRevisionPreview {
  requirements: GoalRequestRequirement[]
  goalContract: GoalContract
  acceptanceSpec: AcceptanceSpec[]
  changed: boolean
}

export function normalizeRequirementRevisionIntent(value: unknown): SessionRequirementRevisionIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('交付要求修订标识无效')
  const intent = value as SessionRequirementRevisionIntent
  if (intent.schemaVersion !== 1 || intent.kind !== 'revise_delivery_requirements' ||
      !Number.isSafeInteger(intent.expectedGoalRevision) || intent.expectedGoalRevision < 1 ||
      !Number.isSafeInteger(intent.expectedWorkItemRevision) || intent.expectedWorkItemRevision < 1) throw new Error('交付要求修订版本无效')
  return { schemaVersion: 1, kind: intent.kind, expectedGoalRevision: intent.expectedGoalRevision, expectedWorkItemRevision: intent.expectedWorkItemRevision }
}

/** The same exact preview is used by the confirmation panel and canonical mutation. */
export function previewSessionRequirementRevision(goal: Goal, workItem: WorkItem, text: string): SessionRequirementRevisionPreview {
  const requirements = extractSessionRequirementRevision(text)
  for (const kind of ['page_count', 'format'] as const) {
    if (requirements.filter(item => item.kind === kind).length > 1) throw new Error('本次包含多个页数或格式要求，请分开明确每份成果的变化')
  }
  const previous = extractGoalRequestRequirements(goal.objective)
  const replaceKinds = new Set(requirements.filter(item => item.kind === 'page_count' || item.kind === 'format').map(item => item.kind))
  const removedTexts = new Set<string>(previous.filter(item => replaceKinds.has(item.kind)).map(item => item.text))
  for (const criterion of [...goal.contract.acceptance, ...workItem.acceptanceSpec]) {
    for (const old of extractGoalRequestRequirements(criterion.criterion)) if (replaceKinds.has(old.kind)) removedTexts.add(old.text)
  }
  const reviseText = (value: string): string => {
    let revised = value
    for (const before of removedTexts) {
      const old = extractGoalRequestRequirements(before)[0]
      const replacement = requirements.find(item => item.kind === old?.kind)
      if (replacement) revised = revised.split(before).join(replacement.text)
    }
    return revised
  }
  const merge = (criteria: AcceptanceSpec[]): AcceptanceSpec[] => {
    const retained = criteria.filter(item => !((item.id.startsWith('request:pages:') && replaceKinds.has('page_count')) ||
      (item.id.startsWith('request:format:') && replaceKinds.has('format'))))
      .map(item => ({ ...item, criterion: reviseText(item.criterion) }))
    for (const requirement of requirements) {
      const criterion = { id: requirement.id, criterion: requirement.text, required: true }
      const index = retained.findIndex(item => item.id === criterion.id)
      if (index >= 0) retained[index] = criterion
      else retained.push(criterion)
    }
    return retained
  }
  const acceptance = merge(goal.contract.acceptance)
  const acceptanceSpec = merge(workItem.acceptanceSpec)
  const unique = (values: string[]) => [...new Set(values)]
  const goalContract = { ...goal.contract,
    constraints: unique([...goal.contract.constraints.map(reviseText), ...requirements.filter(item => item.kind === 'constraint' || item.kind === 'page_count').map(item => item.text)]),
    successCriteria: unique([...goal.contract.successCriteria.map(reviseText), ...requirements.map(item => item.text)]), acceptance }
  return { requirements, goalContract, acceptanceSpec, changed: requirements.length > 0 &&
    (JSON.stringify(goalContract) !== JSON.stringify(goal.contract) || JSON.stringify(acceptanceSpec) !== JSON.stringify(workItem.acceptanceSpec)) }
}

export function extractSessionRequirementRevision(rawText: string): GoalRequestRequirement[] {
  if (typeof rawText !== 'string' || rawText.length > 20_000) return []
  const text = rawText.trim().replace(/^(?:修改|补充|更新)交付要求\s*[:：]\s*/, '')
  if (!text || /[?？]|(?:是否|能否|可否|为什么|怎么样|怎么做|what\b|why\b|how\b|could\b|would\b)/i.test(text)) return []
  if (/```|[“”「」『』"]|^(?:例如|比如|假设|示例|原文|引用|for example\b)/i.test(text)) return []
  const requirements = extractGoalRequestRequirements(text)
  for (const clause of text.split(/[，,。；;！!\n]/).map(value => value.trim()).filter(Boolean)) {
    const pageTarget = /^(?:请|把|将)?\s*第(?:[一二两三四五六七八九十百]+|[1-9][0-9]{0,2})页/.test(clause)
    const targetCommand = pageTarget && /(?:补(?:充|上)?|加上|加入|添加|改为|改成|修改|删除|删掉|移除|保留|替换)/.test(clause)
    if (targetCommand) {
      const sources = /(?:来源|出处|引用|参考文献)/.test(clause) && /(?:补|加|标注|注明)/.test(clause)
      const kind = sources ? 'sources' : 'constraint'
      for (let i = requirements.length - 1; i >= 0; i--) {
        if (requirements[i].kind === kind && clause.includes(requirements[i].text)) requirements.splice(i, 1)
      }
      requirements.push({ id: `request:${kind}:${textIdentity(clause)}`, kind, text: clause })
    }
  }
  return requirements.map(item => item.kind === 'constraint' ? { ...item, id: `request:constraint:${textIdentity(item.text)}` } : item)
}

function textIdentity(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  return (hash >>> 0).toString(16).padStart(8, '0')
}
