import { ipcRenderer } from 'electron'
import type { ChatSnapshotShareApi } from '../shared/chat-snapshot-share-types'
export const chatSnapshotShareApi: ChatSnapshotShareApi = {
  captureChatSnapshot: id => ipcRenderer.invoke('chat-share:capture', id),
  prepareChatSnapshot: (id, input) => ipcRenderer.invoke('chat-share:prepare-snapshot', id, input),
  readChatSnapshot: id => ipcRenderer.invoke('chat-share:read', id),
  listChatSnapshots: id => ipcRenderer.invoke('chat-share:list', id),
  exportChatSnapshot: id => ipcRenderer.invoke('chat-share:export', id),
  saveChatShareAdapter: (id, input) => ipcRenderer.invoke('chat-share:save-adapter', id, input),
  prepareChatShareOperation: input => ipcRenderer.invoke('chat-share:prepare-operation', input),
  executeChatShareOperation: id => ipcRenderer.invoke('chat-share:execute', id),
  inspectChatShareOperation: id => ipcRenderer.invoke('chat-share:inspect', id),
  cancelChatShareOperation: id => ipcRenderer.invoke('chat-share:cancel', id)
}
