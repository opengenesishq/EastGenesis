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
  allowedWriteTools: readonly ['write_file']
}

export interface PreparationPermissionMutation { expectedRevision: number }

export interface PreparationPermissionApi {
  getPreparationPermission(sessionId: string): Promise<PreparationPermissionView>
  grantPreparationPermission(sessionId: string, input: PreparationPermissionMutation): Promise<PreparationPermissionView>
  revokePreparationPermission(sessionId: string, input: PreparationPermissionMutation): Promise<PreparationPermissionView>
}
