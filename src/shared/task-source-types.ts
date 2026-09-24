import type { StudioResultArtifact, StudioResultEvidence } from './studio-result-types'

export interface TaskSourceItem {
  id: string
  kind: 'attachment' | 'artifact' | 'research'
  title: string
  /** Importing a file does not prove that it was included in a sent message. */
  provenance: 'message_attachment' | 'imported_attachment' | 'registered_artifact' | 'registered_source'
  digest?: string
  mime?: string
  bytes?: number
  version?: number
  artifactId?: string
  evidenceId?: string
  sourceContentKind?: 'search_snippet'
  unavailableReason?: string
  historical?: boolean
}
export interface TaskSourceCollection {
  collectionId: string
  sessionId: string
  taskKey: string
  items: TaskSourceItem[]
  warnings: string[]
  memory: { task: true; project: boolean }
}
export interface TaskSourcePreview {
  ok: true
  path: string
  type: 'html' | 'markdown' | 'text' | 'csv' | 'json' | 'image' | 'pdf' | 'office' | 'unknown'
  mode: 'text' | 'asset' | 'unsupported'
  mime: string
  bytes: number
  mtimeMs: number
  content?: string
  dataUrl?: string
}
export interface TaskSourceDetail {
  item: TaskSourceItem
  preview?: TaskSourcePreview
  artifact?: StudioResultArtifact
  evidence?: StudioResultEvidence
}
export interface TaskSourceApi {
  listTaskSources(sessionId: string): Promise<TaskSourceCollection>
  readTaskSource(sessionId: string, collectionId: string, sourceId: string): Promise<TaskSourceDetail>
  /** Resolves only an existing evidence URL; does not navigate or fetch the page. */
  resolveTaskSourceUrl(sessionId: string, collectionId: string, sourceId: string): Promise<string>
}
