import type { ImageAttachmentView, PreviewAnnotation } from './types'

export interface TaskImageItem {
  id: string
  source: 'attachment' | 'artifact'
  attachmentId?: string
  artifactId?: string
  version?: number
  digest?: string
  title: string
  mime: string
  bytes: number
  sourcePath?: string
  unavailableReason?: string
}
export interface TaskImageCollection {
  collectionId: string
  sessionId: string
  taskKey: string
  images: TaskImageItem[]
  warnings: string[]
}
export interface TaskImageAsset {
  imageId: string
  dataUrl: string
  width?: number
  height?: number
}
export interface TaskImageDraft {
  sessionId: string
  taskKey: string
  images: ImageAttachmentView[]
  imagePreviews: Record<string, string>
  /** Each selected source keeps its identity even when equal bytes share an attachment. */
  references: Array<{ imageId: string; attachmentId: string; title: string; sourcePath?: string; artifactId?: string; version?: number; digest: string }>
}
export interface TaskImageAnnotationInput {
  note: string
  boundingBox?: { x: number; y: number; width: number; height: number }
}
export interface TaskImageCanvasApi {
  listTaskImages(sessionId: string): Promise<TaskImageCollection>
  readTaskImage(sessionId: string, collectionId: string, imageId: string, thumbnail?: boolean): Promise<TaskImageAsset>
  prepareTaskImageDraft(sessionId: string, collectionId: string, imageIds: string[]): Promise<TaskImageDraft>
  listTaskImageAnnotations(sessionId: string, collectionId: string, imageId: string): Promise<PreviewAnnotation[]>
  saveTaskImageAnnotation(sessionId: string, collectionId: string, imageId: string, input: TaskImageAnnotationInput): Promise<PreviewAnnotation>
}
