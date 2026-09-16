export const TASK_EXECUTION_AUTHORITY_WRITE_TOOLS = [
  'write_file', 'edit_file', 'search_replace', 'create_document', 'create_spreadsheet',
  'create_presentation', 'create_pdf', 'revise_office_artifact'
] as const

export type TaskExecutionAuthorityWriteTool = typeof TASK_EXECUTION_AUTHORITY_WRITE_TOOLS[number]

export interface TaskExecutionAuthorityMutation { expectedRevision: number }
export interface TaskExecutionAuthorityGrant extends TaskExecutionAuthorityMutation {
  /** Current task/root identity from get(); a stale screen cannot authorize a new directory. */
  expectedBindingDigest: string
  allowedWriteTools: readonly TaskExecutionAuthorityWriteTool[]
  /** Relative globs under the current real task directory; never absolute paths. */
  pathPatterns: readonly string[]
  /** Exact complete bash commands, matched verbatim without wildcard expansion. Omitted means no command authority. */
  allowedCommandPatterns?: readonly string[]
}

export interface TaskExecutionAuthorityView {
  schemaVersion: 1
  sessionId: string
  revision: number
  /** Legacy is compatibility, not a grant inferred from execute/acceptEdits. */
  status: 'legacy' | 'granted' | 'revoked'
  available: boolean
  directory?: string
  bindingDigest?: string
  unavailableReason?: string
  allowedWriteTools: readonly TaskExecutionAuthorityWriteTool[]
  pathPatterns: readonly string[]
  allowedCommandPatterns: readonly string[]
  grantedAt?: number
  revokedAt?: number
}

export interface TaskExecutionAuthorityApi {
  getTaskExecutionAuthority(sessionId: string): Promise<TaskExecutionAuthorityView>
  grantTaskExecutionAuthority(sessionId: string, input: TaskExecutionAuthorityGrant): Promise<TaskExecutionAuthorityView>
  revokeTaskExecutionAuthority(sessionId: string, input: TaskExecutionAuthorityMutation): Promise<TaskExecutionAuthorityView>
}
