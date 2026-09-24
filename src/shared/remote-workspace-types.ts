/** Remote files are a projection of the host's original task, never a local Session. */
export interface RemoteWorkspaceBinding {
  projectId: string
  workItemId: string
  sessionId: string
  runId?: string
  canonicalPath: string
  rootIdentity: string
  authorityDigest: string
  bindingDigest: string
}
export type RemoteWorkspaceOperation = 'describe' | 'list' | 'read' | 'git_status' | 'git_diff' | 'file_info' | 'file_chunk'
export interface RemoteWorkspaceFileVersion { path: string; bytes: number; sha256: string; identity: string }
export interface RemoteWorkspaceRequest {
  workItemId: string
  operation: RemoteWorkspaceOperation
  binding?: RemoteWorkspaceBinding
  path?: string
  cursor?: number
  file?: RemoteWorkspaceFileVersion
  offset?: number
}
export interface RemoteWorkspaceEntry { name: string; path: string; kind: 'directory' | 'file' | 'unavailable' }
export interface RemoteWorkspaceResult {
  protocolVersion: 1
  deviceId: string
  projectId: string
  binding: RemoteWorkspaceBinding
  operation: RemoteWorkspaceOperation
  title: string
  entries?: RemoteWorkspaceEntry[]
  nextCursor?: number
  path?: string
  content?: string
  digest?: string
  gitHead?: string
  file?: RemoteWorkspaceFileVersion
  chunkBase64?: string
  chunkOffset?: number
  chunkSha256?: string
}
export interface RemoteWorkspaceView extends RemoteWorkspaceResult { hostId: string }
export interface RemoteWorkspaceSaveResult { status: 'saved' | 'cancelled'; path?: string; bytes?: number; sha256?: string }
