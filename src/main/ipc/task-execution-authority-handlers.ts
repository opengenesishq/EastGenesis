import { app, ipcMain } from 'electron'
import type { TaskExecutionAuthorityGrant, TaskExecutionAuthorityMutation } from '../../shared/task-execution-authority-types'
import { sessionManager } from '../sessionManager'
import { TaskExecutionAuthorityStore, taskExecutionAuthorityBindingDigest } from '../permission/task-execution-authority-store'
import { withActiveTaskExecutionAuthoritySession } from '../permission/task-execution-authority-lifecycle'
import { assertPersistedSessionDomainOwnership } from '../session-create-lifecycle'
import { writeSessionAuditLog } from '../permission/audit-log'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { sessionReadyHandler } from './session-ready-handler'

export function registerTaskExecutionAuthorityIpc(): void {
  const root = app.getPath('userData')
  const store = new TaskExecutionAuthorityStore(root)
  const currentMeta = (id: string) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('任务身份无效。')
    const meta = sessionManager.get(id)?.meta
    if (!meta) throw new Error('请先打开原始任务。')
    return meta
  }
  ipcMain.handle('taskExecutionAuthority:get', sessionReadyHandler((event, id: string) => {
    assertTrustedWorkflowLedgerSender(event)
    return store.get(currentMeta(id))
  }))
  for (const operation of ['grant', 'revoke'] as const) {
    ipcMain.handle(`taskExecutionAuthority:${operation}`, sessionReadyHandler((event, id: string,
      input: TaskExecutionAuthorityGrant | TaskExecutionAuthorityMutation) => {
      assertTrustedWorkflowLedgerSender(event)
      return withActiveTaskExecutionAuthoritySession(root, id, currentMeta,
        meta => assertPersistedSessionDomainOwnership(meta, root), async () => {
          const before = currentMeta(id)
          const binding = taskExecutionAuthorityBindingDigest(before)
          store.assertMutation(before, input, operation)
          const actor = `local-user:webcontents-${event.sender.id}`
          if (operation === 'revoke') {
            // Revocation must succeed even if an unrelated Run cannot save
            // its snapshot. The private revoked record is the write barrier.
            const result = store.revoke(before, input, actor)
            try { await sessionManager.requireTaskExecutionAuthority(id) }
            catch (error) { console.error('[Task authority] Revoked access; Session synchronization failed', error) }
            writeSessionAuditLog({ ...before, taskStrategy: 'plan' }, {
              action: 'deny', source: 'user', toolName: 'task_file_authority',
              input: { operation, revision: result.revision, pathPatterns: result.pathPatterns, allowedWriteTools: result.allowedWriteTools },
              message: '用户撤销当前任务的 Agent 文件修改授权。'
            })
            return result
          }
          await sessionManager.requireTaskExecutionAuthority(id)
          const meta = currentMeta(id)
          if (taskExecutionAuthorityBindingDigest(meta) !== binding) throw new Error('任务归属已变化，请重新打开当前任务。')
          await assertPersistedSessionDomainOwnership(meta, root)
          const live = currentMeta(id)
          if (taskExecutionAuthorityBindingDigest(live) !== binding) throw new Error('任务归属已变化，请重新打开当前任务。')
          const result = store.grant(live, input as TaskExecutionAuthorityGrant, actor)
          writeSessionAuditLog({ ...live, taskStrategy: 'plan' }, {
            action: 'allow', source: 'user', toolName: 'task_file_authority',
            input: { operation, revision: result.revision, pathPatterns: result.pathPatterns, allowedWriteTools: result.allowedWriteTools },
            message: '用户限定当前任务的 Agent 文件修改范围。'
          })
          return result
        })
    }))
  }
}
