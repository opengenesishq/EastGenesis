import { ipcRenderer } from 'electron'
import type { TaskImageCanvasApi } from '../shared/image-canvas-types'
export const imageCanvasApi: TaskImageCanvasApi = {
  listTaskImages: sessionId => ipcRenderer.invoke('images:list', sessionId),
  readTaskImage: (sessionId, collectionId, imageId, thumbnail) => ipcRenderer.invoke('images:read', sessionId, collectionId, imageId, thumbnail),
  prepareTaskImageDraft: (sessionId, collectionId, imageIds) => ipcRenderer.invoke('images:draft', sessionId, collectionId, imageIds),
  listTaskImageAnnotations: (sessionId, collectionId, imageId) => ipcRenderer.invoke('images:annotations', sessionId, collectionId, imageId),
  saveTaskImageAnnotation: (sessionId, collectionId, imageId, input) => ipcRenderer.invoke('images:annotate', sessionId, collectionId, imageId, input)
}
