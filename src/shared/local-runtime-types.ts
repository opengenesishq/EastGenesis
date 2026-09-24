export interface LocalRuntimeInfo {
  id: 'node' | 'python' | 'git'
  name: string
  available: boolean
  executable?: string
  version?: string
  error?: string
}
export interface LocalRuntimeStatus {
  checkedAt: number
  platform: string
  runtimes: LocalRuntimeInfo[]
  bundledDocuments: boolean
}
