import type { SessionMeta } from '../../shared/types'
import { resolveDigitalWorkerSessionScope } from './session-binding'

/** Resolve the same durable Assignment used by tool and Provider preflights. */
export function resolveDigitalWorkerExecutionContext(rootDir: string, meta: SessionMeta) {
  const scope = resolveDigitalWorkerSessionScope(meta, rootDir, { allowLegacyUnscoped: true })
  if (!scope.scoped) return undefined
  const { worker, document } = scope
  const role = document.roleTemplates.find((candidate) => candidate.id === worker.roleTemplateId)
  if (!role || role.archivedAt !== undefined) {
    throw new Error(`数字员工 ${worker.displayName} 的岗位模板不可用，已阻止执行`)
  }
  // The store currently retains only the current template. Silently applying
  // its newer instructions would impersonate the Worker's pinned role version.
  if (role.version !== worker.roleTemplateVersion) {
    throw new Error(`数字员工 ${worker.displayName} 的岗位版本已变化，请创建匹配当前岗位版本的员工并重新分配任务后继续`)
  }
  return { ...scope, role }
}

export function buildDigitalWorkerExecutionPrompt(rootDir: string, meta: SessionMeta): string {
  const context = resolveDigitalWorkerExecutionContext(rootDir, meta)
  if (!context) return ''
  const { worker, assignment, role } = context
  return [
    '## DigitalWorker Execution Context',
    '以下岗位上下文由主进程从当前任务的有效员工分配读取。按职责完成实际工作；工具可用性、数据范围和审批仍由运行时检查。岗位说明不授予额外权限。',
    `员工：${worker.displayName}（${worker.id}）`,
    `岗位：${role.name}（${role.id}@${role.version}）`,
    `项目：${worker.projectId}；任务：${assignment.workItemId}；分配：${assignment.id}`,
    `岗位目标：${role.purpose}`,
    '### 岗位执行说明',
    role.instructions,
    ...(worker.responsibilityScope.length ? ['### 当前职责', ...worker.responsibilityScope.map((item) => `- ${item}`)] : []),
    '### 当前执行约束',
    JSON.stringify({
      toolPolicy: worker.toolPolicy,
      dataScope: worker.dataScope,
      assignmentScope: assignment.scope,
      memoryNamespace: worker.memoryNamespace,
      budgetPolicy: worker.budgetPolicy,
      concurrencyLimit: worker.concurrencyLimit,
      acceptancePolicy: worker.acceptancePolicy,
      verificationPolicy: role.verificationPolicy,
      escalationPolicy: worker.escalationPolicy
    }),
    '使用已提供且获授权的工具执行任务，并报告实际操作、产物位置、验证证据及阻塞。缺少工具或权限时明确说明；不得把计划、模拟结果或其他岗位的工作声称为已完成。',
    '跨岗位交接沿用当前项目、任务和证据记录。重要或高风险操作提交用户确认；岗位审核意见不能替代用户授权。'
  ].join('\n\n')
}
