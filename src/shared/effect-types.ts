import type { OfficeRevisionEffectTarget } from './office-revision-types'
export type EffectStatus =
  | 'prepared'
  | 'executing'
  | 'waiting_reconciliation'
  | 'confirmed'
  | 'failed'
  | 'compensated'
  | 'abandoned'

export type EffectEvidenceKind =
  | 'prepared'
  | 'executing'
  | 'execution_result'
  | 'reconciliation'
  | 'retry_authorized'
  | 'manual_confirmation'
  | 'compensation'

export type InteractiveOperationKind =
  | 'file_write'
  | 'attachment_write'
  | 'mcp_probe'
  | 'migration_import'
  | 'terminal_action'
  | 'browser_navigation'
  | 'plugin_install'
  | 'plugin_uninstall'
  | 'workspace_hunk_discard'
  | 'git_commit'
  | 'git_index_update'
  | 'workspace_handoff'
  | 'task_handoff'
  | 'managed_worktree_create'
  | 'managed_worktree_remove'
  | 'worktree_patch_apply'
  | 'git_push'
  | 'pull_request_create'
  | 'issue_create'
  | 'checkpoint_restore'
  | 'provider_operation'
  | 'migration_apply'
  | 'migration_rollback'
  | 'project_export'
  | 'project_import'
  | 'project_delete'
  | 'media_generation'

export type InteractiveOperationSource = 'renderer' | 'dag' | 'session_lifecycle'

export interface MigrationImportOperationResult {
  ok: boolean
  summary?: string
  error?: string
  effectStatus?: EffectStatus
  operationId?: string
  snapshotId?: string
}

export interface TaskRunOperationMetadata {
  schemaVersion: 1
  operationId: string
  source: InteractiveOperationSource
  kind: InteractiveOperationKind
  sourceSessionId: string
  projectId?: string
  title: string
}

export interface EffectLease {
  id: string
  ownerId: string
  fencingToken: number
  acquiredAt: number
  expiresAt: number
  releasedAt?: number
}

export interface EffectEvidenceRecord {
  id: string
  kind: EffectEvidenceKind
  digest: string
  observedAt: number
  verifier: string
  generation: number
  /** Optional for historical records; manual decisions bind the exact observed version. */
  resolutionReceipt?: import('./effect-recovery-types').EffectResolutionReceipt
}

export interface FileSystemIdentity {
  device: string
  inode: string
}

export interface OfficeSourceSnapshot {
  path: string
  identity: FileSystemIdentity
  sha256: string
  bytes: number
}

export interface ManagedWorktreeProjectionRecord {
  sessionId: string
  repoRoot: string
  sourceCwd: string
  worktreePath: string
  cwd: string
  branch: string
  baseSha: string
  baseBranch: string | null
  state: 'active' | 'removed'
  createdAt: number
  updatedAt: number
}

export type EffectTarget = { executionEnvironment?: import('./wsl-types').WslExecutionBinding } & (
  | { kind: 'workspace_handoff'; sessionId: string; journalId: string; journalDigest: string; userDataRoot: string; repoRoot: string; worktreePath: string; direction: 'worktree' | 'local' }
  | { kind: 'task_handoff'; sessionId: string; handoffId: string; bundleDigest: string; previewDigest: string; sourceHostId: string; targetHostId: string; rootDir: string }
  | {
      kind: 'gui_postcondition'
      platform: 'win32' | 'darwin'
      toolName: 'gui_activate_window' | 'gui_click' | 'gui_type' | 'gui_scroll' | 'gui_hotkey'
      postcondition: {
        kind: 'window' | 'element'
        state: 'exists' | 'absent' | 'enabled' | 'disabled' | 'visible' | 'hidden'
        windowId: string
        elementId?: string
        maxElements?: number
      }
      preconditionSatisfied: false
    }
  | {
      kind: 'file_content'
      rootPath: string
      rootIdentity?: FileSystemIdentity
      relativePath: string
      preState: 'absent' | 'file'
      preFileIdentity?: FileSystemIdentity
      preSha256?: string
      preBytes?: number
      expectedState?: 'absent' | 'file'
      expectedSha256: string
      expectedBytes: number
    }
  | {
      kind: 'git_commit'
      repoRoot: string
      branch: string
      preHead: string
      stagedDiffDigest: string
      messageDigest: string
    }
  | {
      kind: 'git_index_update'
      repoRoot: string
      repoRootIdentity: FileSystemIdentity
      gitCommonDir: string
      gitCommonDirIdentity: FileSystemIdentity
      worktreeGitDir: string
      worktreeGitDirIdentity: FileSystemIdentity
      objectDir: string
      objectDirIdentity: FileSystemIdentity
      objectFormat: 'sha1' | 'sha256'
      indexPath: string
      preHeadState: 'commit' | 'unborn'
      preHead?: string
      headRef?: string
      preIndexState: 'absent' | 'file'
      preIndexIdentity?: FileSystemIdentity
      preIndexSha256?: string
      preIndexBytes?: number
      preIndexEntriesDigest: string
      expectedIndexEntriesDigest: string
      operation: 'stage_paths' | 'stage_all' | 'unstage_paths' | 'apply_cached_hunk'
      paths: string[]
      worktreeReadScope: 'none' | 'paths' | 'all'
      scopePath?: string
      patchSha256?: string
      patchBytes?: number
      /** Stable app-private reference used to resolve the frozen bytes after Project import. */
      artifactRef?: string
      artifactRoot: string
      artifactRootIdentity: FileSystemIdentity
      indexArtifactPath: string
      indexArtifactIdentity: FileSystemIdentity
      indexArtifactSha256: string
      indexArtifactBytes: number
      objectManifestPath: string
      objectManifestIdentity: FileSystemIdentity
      objectManifestSha256: string
      objectCount: number
    }
  | {
      kind: 'git_merge'
      repoRoot: string
      gitCommonDir: string
      worktreeGitDir: string
      repoRootIdentity: FileSystemIdentity
      gitCommonDirIdentity: FileSystemIdentity
      worktreeGitDirIdentity: FileSystemIdentity
      destinationRef: string
      preHead: string
      preTree: string
      sourceRef: string
      sourceSha: string
      sourceWasAncestor: boolean
      mode: 'no_ff_v1'
    }
  | {
      kind: 'git_push'
      repoRoot: string
      remote: string
      pushUrlDigest: string
      branch: string
      ref: string
      intendedSha: string
    }
  | {
      kind: 'worktree_patch_apply'
      repoRoot: string
      repoRootIdentity: FileSystemIdentity
      gitCommonDir: string
      gitCommonDirIdentity: FileSystemIdentity
      worktreePath: string
      worktreeRootIdentity: FileSystemIdentity
      baseSha: string
      headSha: string
      preHead: string
      patchPath: string
      patchFileIdentity: FileSystemIdentity
      patchSha256: string
      patchBytes: number
      changedPaths: string[]
      mode?: 'apply' | 'reverse'
    }
  | {
      kind: 'code_forge_patch'
      targetKind: 'repository' | 'managed-worktree'
      sessionId?: string
      repoRoot: string
      repoRootIdentity: FileSystemIdentity
      gitCommonDir: string
      gitCommonDirIdentity: FileSystemIdentity
      worktreePath: string
      worktreeRootIdentity: FileSystemIdentity
      worktreeGitDir: string
      worktreeGitDirIdentity: FileSystemIdentity
      branch?: string
      baseBranch?: string | null
      baseSha: string
      headSha: string
      changedPaths: string[]
      insertions: number
      deletions: number
      conflictRisk?: 'low' | 'medium' | 'unknown'
      canApply?: boolean
      applyError?: string
      conflictFiles?: string[]
      sourceStateDigest: string
      artifactRoot: string
      artifactRootIdentity: FileSystemIdentity
      artifactPath: string
      artifactPreState: 'absent' | 'file'
      artifactPreFileIdentity?: FileSystemIdentity
      artifactPreSha256?: string
      artifactPreBytes?: number
      patchSha256: string
      patchBytes: number
    }
  | {
      kind: 'git_worktree_create'
      sessionId: string
      sourceCwd: string
      sourceCwdIdentity: FileSystemIdentity
      repoRoot: string
      repoRootIdentity: FileSystemIdentity
      gitCommonDir: string
      gitCommonDirIdentity: FileSystemIdentity
      sourceWorktreeGitDir: string
      sourceWorktreeGitDirIdentity: FileSystemIdentity
      worktreePath: string
      worktreeCwd: string
      sourcePrefix: string
      worktreeParentPath: string
      worktreeParentPreState: 'absent' | 'directory'
      worktreeParentPreIdentity?: FileSystemIdentity
      worktreeParentAnchorPath: string
      worktreeParentAnchorIdentity: FileSystemIdentity
      branch: string
      branchRef: string
      baseSha: string
      baseBranch: string | null
      sourceHeadRef: string | null
      registryRecord: ManagedWorktreeProjectionRecord
    }
  | {
      kind: 'git_worktree_remove'
      sessionId: string
      sourceCwd: string
      sourceCwdIdentity: FileSystemIdentity
      repoRoot: string
      repoRootIdentity: FileSystemIdentity
      gitCommonDir: string
      gitCommonDirIdentity: FileSystemIdentity
      sourceWorktreeGitDir: string
      sourceWorktreeGitDirIdentity: FileSystemIdentity
      sourceHead: string
      sourceHeadRef: string | null
      worktreePath: string
      worktreeCwd: string
      sourcePrefix: string
      worktreeRootIdentity: FileSystemIdentity
      worktreeGitDir: string
      worktreeGitDirIdentity: FileSystemIdentity
      branch: string
      branchRef: string
      branchSha: string
      headSha: string
      baseSha: string
      baseBranch: string | null
      worktreeStatusDigest: string
      worktreeOperationStateDigest: string
      preStateDigest: string
      force: boolean
      deleteBranch: boolean
      registryRecord: ManagedWorktreeProjectionRecord
    }
  | {
      kind: 'pull_request_create'
      provider: 'github' | 'gitlab'
      repoRoot: string
      repoRootIdentity: FileSystemIdentity
      remote: string
      remoteUrlDigest: string
      host: string
      projectPath: string
      repositoryDigest: string
      sourceBranch: string
      sourceSha: string
      baseBranch: string
      titleDigest: string
      bodyDigest: string
      marker: string
    }
  | {
      kind: 'issue_create'
      provider: 'github' | 'gitlab'
      repoRoot: string
      repoRootIdentity: FileSystemIdentity
      remote: string
      remoteUrlDigest: string
      host: string
      projectPath: string
      repositoryDigest: string
      titleDigest: string
      bodyDigest: string
      labels: string[]
      labelsDigest: string
      markerToken: string
      marker: string
    }
  | {
      kind: 'mcp_tool_call'
      transport: 'stdio' | 'http' | 'sse'
      command?: string
      commandArgs?: string[]
      url?: string
      serverIdentityDigest: string
      /** Added in v2; legacy targets remain readable but cannot resume without this binding. */
      pluginRegistryItemKey?: string
      pluginContentDigest?: string
      pluginCapabilityDigest?: string
      pluginServerId?: string
      discoveryDigest: string
      toolName: string
      toolArgumentsDigest: string
      queryToolName: string
      queryArguments: Record<string, unknown>
      queryArgumentsDigest: string
      jsonPointer: string
      expectedValueDigest: string
    }
  | {
      kind: 'webhook_message_send'
      connectorId: string
      connectorRevision: number
      channel: 'feishu' | 'dingtalk'
      webhookDigest: string
      payloadDigest: string
      titleDigest: string
      textDigest: string
      linkUrlDigest?: string
    }
  | OfficeRevisionEffectTarget
  | {
      kind: 'office_artifact'
      /** 对应 canonical Artifact 的 kind，非 artifact 自身 kind 字段。 */
      artifactKind: 'document' | 'spreadsheet' | 'presentation' | 'pdf'
      /** 审批时冻结的 Project 根及文件系统身份，防止路径在执行前被替换。 */
      rootPath: string
      rootIdentity: FileSystemIdentity
      relativePath: string
      /** Project 工作区内绝对路径（与 ArtifactLifecycleRegistrationInput.content.sourceRef 一致） */
      workspacePath: string
      /** 结构化输入摘要；生成前不伪造尚未知的二进制摘要。 */
      specDigest: string
      /** 新版确定性输出绑定；缺省表示旧版只读 Effect，禁止自动执行/确认/交接。 */
      outputBindingVersion?: 1
      /** 审批前确定性生成并冻结的输出字节摘要；可选仅用于读取旧版持久化 Effect。 */
      expectedSha256?: string
      /** 与 expectedSha256 成对存在的审批输出字节长度。 */
      expectedBytes?: number
      /** OOXML media type：
       *  document → application/vnd.openxmlformats-officedocument.wordprocessingml.document
       *  spreadsheet → application/vnd.openxmlformats-officedocument.spreadsheetml.sheet */
      mediaType: string
      /** 来源材料引用（输入文档/数据表的 workspace 路径或 sourceRef），用于可追溯 */
      sourceRefs: string[]
      /** 新建 Effect 冻结来源文件身份与内容；可选仅用于读取旧版持久化 Effect。 */
      sourceSnapshots?: OfficeSourceSnapshot[]
      title: string
    }
  | {
      kind: 'managed_plugin_install'
      rootPath: string
      rootAnchorPath: string
      rootAnchorIdentity: FileSystemIdentity
      rootPreState: 'absent' | 'directory'
      rootIdentity?: FileSystemIdentity
      pluginName: string
      targetPreState: 'absent' | 'directory'
      targetPreIdentity?: FileSystemIdentity
      targetPreDigest?: string
      targetPreFiles?: number
      targetPreBytes?: number
      expectedDigest: string
      expectedFiles: number
      expectedBytes: number
      stagingRelativePath: string
      trashRelativePath?: string
    }
  | {
      kind: 'managed_plugin_uninstall'
      rootPath: string
      rootAnchorPath: string
      rootAnchorIdentity: FileSystemIdentity
      rootIdentity: FileSystemIdentity
      pluginName: string
      targetPreIdentity: FileSystemIdentity
      targetPreDigest: string
      targetPreFiles: number
      targetPreBytes: number
      trashRelativePath: string
    }
  | {
      kind: 'project_portable_export'
      projectId: string
      goalId: string
      workItemId: string
      runId: string
      artifactId: string
      evidenceId: string
      acceptanceId: string
      format: 'caogen.project-aggregate.v1'
    }
  | {
      kind: 'project_portable_import'
      operationId: string
      importedProjectId: string
      exportDigest: string
      sourceAggregateDigest: string
      projectId: string
      goalId: string
      workItemId: string
      runId: string
      artifactId: string
      evidenceId: string
      acceptanceId: string
      format: 'caogen.project-aggregate.v1'
    }
  | {
      kind: 'project_permanent_deletion'
      deletionOperationId: string
      deletedProjectId: string
      expectedWorkspaceRevision: number
      projectId: string
      goalId: string
      workItemId: string
      runId: string
      artifactId: string
      evidenceId: string
      acceptanceId: string
    }
  | {
      kind: 'migration_operation'
      operation: 'apply' | 'rollback'
      /** Stable portable identity; the absolute private Store path stays in the main process. */
      backupRef?: 'caogen-private:migration-backups'
      /** Legacy compatibility for Effects written before private-reference binding. */
      backupRoot?: string
      backupId: string
      assetCount: number
      kindCounts: {
        rules: number
        mcp: number
        config: number
        skill: number
        prompt: number
        usage: number
        hook: number
        memory: number
        routine: number
        channel: number
      }
      selectionDigest: string
      expectedState: 'committed' | 'rolled_back'
    }
  | {
      kind: 'provider_profile_operation'
      operation: 'profile_import' | 'backup_restore' | 'backup_delete' | 'sync_publish' | 'sync_apply'
      transport: 'local' | 'folder' | 'webdav' | 's3'
      projectId: string
      goalId: string
      workItemId: string
      runId: string
      artifactId: string
      evidenceId: string
      acceptanceId: string
      /** Present only for backup_delete; the raw local backup id never enters the Effect ledger. */
      backupIdDigest?: string
    }
  | {
      kind: 'media_job_operation'
      operation: 'submit' | 'poll' | 'download' | 'cancel' | 'asset_import' | 'compose' | 'continuity_check'
      mediaJobId: string
      externalJobId: string
      idempotencyKeyDigest: string
      projectId: string
      goalId: string
      workItemId: string
      runId: string
      expectedStatus: 'submitting' | 'running' | 'downloading' | 'succeeded' | 'failed' | 'cancelled' | 'waiting_reconciliation'
      artifactId?: string
      evidenceId?: string
      acceptanceId?: string
    }
  | {
      kind: 'unsupported'
      toolName: string
      browserDebug?: import('./browser-debug-types').BrowserDebugEvaluationBinding
      /** Opaque browser mutations still bind approval to one live document. */
      browserPage?: {
        embedded?: import('./browser-tab-types').BrowserTabTarget
        viewId: string
        navigationRevision: number
        urlDigest: string
        documentToken: string
        /** Only a digest of target/form contents is persisted. Old records
         * without this binding cannot authorize another browser mutation. */
        actionTarget?: {
          kind: 'browser_click' | 'browser_type' | 'browser_evaluate'
          nodeToken: string
          version: number
          stateDigest: string
        }
        /** External Chrome/Edge binding. Presence means this target is not an
         * embedded BrowserView and must be executed through its connection. */
        external?: {
          connectionId: string
          tabId: string
          pageRevision: number
          selectionRevision?: number
        }
      }
    }

)

export interface EffectRecord {
  schemaVersion: 1
  id: string
  effectKey: string
  resourceKey: string
  sessionId: string
  runId: string
  stepId?: string
  toolExecutionId?: string
  toolUseId: string
  toolName: string
  generation: number
  revision: number
  status: EffectStatus
  reconcilability: 'queryable' | 'opaque'
  target: EffectTarget
  targetDigest: string
  intentDigest: string
  inputDigest: string
  lease?: EffectLease
  evidence: EffectEvidenceRecord[]
  compensationEffectId?: string
  createdAt: number
  updatedAt: number
  terminalAt?: number
  error?: string
}
