import { resolveBusinessLineId } from '../../../shared/business-line-types'
import type { AppSettings, HistoryEntry, SessionMeta } from '../../../shared/types'

export interface ExperiencePreferenceRecommendation {
  id: string
  mode?: AppSettings['experienceMode']
  layout?: Partial<AppSettings['layout']>
  confidence: 'medium' | 'high'
  projectTaskCount: number
  conversationTaskCount: number
  projectCount: number
}

export function recommendExperiencePreferences(input: {
  settings: AppSettings
  sessions: readonly SessionMeta[]
  history: readonly HistoryEntry[]
  projectCount: number
}): ExperiencePreferenceRecommendation | undefined {
  const records = uniqueTaskRecords(input.sessions, input.history).filter((record) => ['assistant', 'studio'].includes(resolveBusinessLineId(record))).slice(0, 40)
  const projectTaskCount = records.filter(isProjectTask).length
  const conversationTaskCount = records.filter((record) => !isProjectTask(record)).length
  const studioScore = records.reduce((score, record) => score + recordScore(record), 0)
  const mode = recommendedMode(input.settings.experienceMode, records.length, studioScore)
  const layout = recommendedLayout(input.settings.layout, records.length, input.projectCount)
  if (!mode && !layout) return undefined

  const projectBucket = Math.min(9, input.projectCount)
  const recordBucket = Math.min(40, records.length)
  const id = [
    'experience-v1',
    mode ?? 'same',
    layout?.chatDensity ?? 'same',
    layout?.sidebarCollapsed === undefined ? 'same' : layout.sidebarCollapsed ? 'collapsed' : 'expanded',
    layout?.sidebarWidth ?? 'same',
    projectBucket,
    recordBucket,
    projectTaskCount,
    conversationTaskCount
  ].join(':')
  if (input.settings.experienceRecommendationDismissedId === id) return undefined

  return {
    id,
    ...(mode ? { mode } : {}),
    ...(layout ? { layout } : {}),
    confidence: Math.abs(studioScore) >= 12 || input.projectCount >= 5 || records.length >= 20 ? 'high' : 'medium',
    projectTaskCount,
    conversationTaskCount,
    projectCount: input.projectCount
  }
}

function uniqueTaskRecords(
  sessions: readonly SessionMeta[],
  history: readonly HistoryEntry[]
): Array<SessionMeta | HistoryEntry> {
  const records = new Map<string, SessionMeta | HistoryEntry>()
  for (const record of [...history].sort((left, right) => right.updatedAt - left.updatedAt)) {
    records.set(record.sdkSessionId || record.id, record)
  }
  for (const record of [...sessions].sort((left, right) => right.createdAt - left.createdAt)) {
    records.set(record.sdkSessionId || record.id, record)
  }
  return [...records.values()].sort((left, right) => taskTimestamp(right) - taskTimestamp(left))
}

function taskTimestamp(record: SessionMeta | HistoryEntry): number {
  return 'updatedAt' in record ? record.updatedAt : record.createdAt
}

function isProjectTask(record: SessionMeta | HistoryEntry): boolean {
  return resolveBusinessLineId(record) === 'studio'
}

function recordScore(record: SessionMeta | HistoryEntry): number {
  // Managed personal tasks also own Goals and WorkItems; those IDs are not project preference signals.
  if (!isProjectTask(record)) return -4
  return 4 + (record.taskStrategy === 'plan' ? 1 : 0)
}

function recommendedMode(
  current: AppSettings['experienceMode'],
  sampleSize: number,
  studioScore: number
): AppSettings['experienceMode'] | undefined {
  if (sampleSize < 6) return undefined
  if (studioScore >= 8 && current !== 'studio') return 'studio'
  if (studioScore <= -8 && current !== 'assistant') return 'assistant'
  return undefined
}

function recommendedLayout(
  current: AppSettings['layout'],
  taskCount: number,
  projectCount: number
): Partial<AppSettings['layout']> | undefined {
  const patch: Partial<AppSettings['layout']> = {}
  if ((taskCount >= 16 || projectCount >= 4) && current.chatDensity !== 'compact') {
    patch.chatDensity = 'compact'
  }
  if (projectCount >= 4 && current.sidebarCollapsed) patch.sidebarCollapsed = false
  if (projectCount >= 5 && current.sidebarWidth < 248) patch.sidebarWidth = 248
  return Object.keys(patch).length > 0 ? patch : undefined
}
