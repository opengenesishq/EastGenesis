import type { LearningRecord, LearningStatus } from './learning-types'

export interface LegacyMemoryPreviewEntry {
  entryKey: string
  sourceDigest: string
  sourceId: string
  storage: 'learning' | 'confirmed' | 'drafts' | 'layered'
  sourceState: 'active' | 'draft'
  sourceVersion?: number
  updatedAt: string
  kind: string
  title: string
  body: string
  source: string
  reason: string
  imported?: { recordId: string; status: LearningStatus }
}

export interface LegacyMemoryPreview {
  schemaVersion: 1
  projectId: string
  sourceDirectory: string
  entries: LegacyMemoryPreviewEntry[]
}

/** Source directories and memory bodies are always re-derived in the main process. */
export interface LegacyMemoryImportInput {
  expectedProjectId: string
  entryKey: string
  sourceDigest: string
}

export interface LegacyMemoryImportResult {
  projectId: string
  entryKey: string
  sourceDigest: string
  record: LearningRecord
  replayed: boolean
}
