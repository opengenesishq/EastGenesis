export interface PreparationPermissionView {
  schemaVersion: 1
  sessionId: string
  revision: number
  status: 'none' | 'granted' | 'revoked'
  /** True only when the current Session still owns the real isolated directory. */
  available: boolean
  directory?: string
  unavailableReason?: string
  grantedAt?: number
  revokedAt?: number
  allowedWriteTools: readonly PreparationWriteTool[]
}

export interface PreparationPermissionMutation {
  expectedRevision: number
  /** Explicit grant scope. Omission keeps existing grants, or grants text only. */
  allowedWriteTools?: readonly PreparationWriteTool[]
}

export interface PreparationPermissionApi {
  getPreparationPermission(sessionId: string): Promise<PreparationPermissionView>
  grantPreparationPermission(sessionId: string, input: PreparationPermissionMutation): Promise<PreparationPermissionView>
  revokePreparationPermission(sessionId: string, input: PreparationPermissionMutation): Promise<PreparationPermissionView>
}
export const PREPARATION_WRITE_TOOLS = ['write_file', 'create_document', 'create_spreadsheet', 'create_presentation', 'create_pdf'] as const
export type PreparationWriteTool = typeof PREPARATION_WRITE_TOOLS[number]
