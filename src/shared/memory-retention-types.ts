export type MemoryRetentionLayer = 'working' | 'project' | 'user'

export interface MemoryRetentionSetting {
  layer: MemoryRetentionLayer
  available: boolean
  days: number | null
}

export interface MemoryRetentionView {
  revision: number
  settings: MemoryRetentionSetting[]
}

export interface MemoryRetentionInput {
  layer: MemoryRetentionLayer
  days: number | null
  expectedRevision: number
}

export interface MemoryRetentionPreview extends MemoryRetentionInput {
  evaluatedAt: number
  digest: string
  layeredCount: number
  projectCount: number
}

export interface MemoryRetentionSaveInput extends MemoryRetentionInput {
  evaluatedAt: number
  digest: string
}
