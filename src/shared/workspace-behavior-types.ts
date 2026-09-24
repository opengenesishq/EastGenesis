export type ExternalEditorId = 'systemText' | 'vscode' | 'cursor' | 'zed' | 'sublime' | 'custom'
export interface WorkspaceBehaviorPreferences {
  fileTabsPosition: 'top' | 'bottom'
  externalEditor: ExternalEditorId
  customEditorPath?: string
}
export interface ExternalEditorChoice { id: ExternalEditorId; name: string; available: boolean; path?: string }
export interface WorkspaceBehaviorApi {
  listExternalEditors(): Promise<ExternalEditorChoice[]>
  chooseExternalEditor(): Promise<string | null>
  openWorkspaceFileInEditor(input: { sessionId: string; path: string }): Promise<void>
}
export function normalizeWorkspaceBehavior(raw: unknown): WorkspaceBehaviorPreferences {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw new Error('文件工作区偏好无效。')
  const value = (raw ?? {}) as Record<string, unknown>
  const position = value.fileTabsPosition ?? 'top', editor = value.externalEditor ?? 'systemText'
  if (position !== 'top' && position !== 'bottom') throw new Error('文件标签位置无效。')
  if (typeof editor !== 'string' || !['systemText', 'vscode', 'cursor', 'zed', 'sublime', 'custom'].includes(editor)) throw new Error('外部编辑器选项无效。')
  const custom = value.customEditorPath
  if (custom !== undefined && (typeof custom !== 'string' || custom.length > 4096 || /[\x00-\x1f\x7f]/.test(custom) || !/^(?:\/|[a-z]:[\\/])/i.test(custom))) throw new Error('请选择本机编辑器程序的完整路径。')
  return { fileTabsPosition: position, externalEditor: editor as ExternalEditorId, ...(custom ? { customEditorPath: custom as string } : {}) }
}
