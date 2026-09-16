import { BrowserWindow, dialog, type WebContents } from 'electron'
import type { EffectRecord, SessionMeta, TaskSnapshotRecord } from '../../shared/types'
import type { EffectResolution } from '../../shared/effect-recovery-types'

export interface EffectResolutionContext {
  listTaskSnapshots(): Promise<TaskSnapshotRecord[]>
  getTaskSnapshot?(snapshotId: string): Promise<TaskSnapshotRecord | null>
  resolveTaskEffect(
    snapshotId: string,
    effectId: string,
    expectedRevision: number,
    resolution: EffectResolution,
    note?: string
  ): Promise<{ snapshot: TaskSnapshotRecord; resumedSession?: SessionMeta }>
  updateWorktreeState(sessionId: string, state: 'active' | 'removed'): void
  describeTarget(effect: EffectRecord): string
  describeIntent(snapshot: TaskSnapshotRecord, effect: EffectRecord): string
}

export async function resolveTaskSnapshotEffect(
  sender: WebContents,
  snapshotId: string,
  effectId: string,
  expectedRevision: number,
  resolution: EffectResolution,
  context: EffectResolutionContext,
  note?: string
): Promise<{ snapshot: TaskSnapshotRecord; resumedSession?: SessionMeta }> {
  validateResolutionInput(snapshotId, effectId, expectedRevision, resolution)
  if (note !== undefined && (typeof note !== 'string' || !note.trim() || note.length > 2000)) throw new Error('核对说明须为 1-2000 字符')
  const snapshot = context.getTaskSnapshot ? await context.getTaskSnapshot(snapshotId)
    : (await context.listTaskSnapshots()).find((item) => item.id === snapshotId)
  const effect = snapshot?.run?.effects?.find((item) => item.id === effectId)
  if (!snapshot || !effect) throw new Error('EffectRecord 已不存在，请刷新恢复列表')
  if (effect.status !== 'waiting_reconciliation') {
    throw new Error(`EffectRecord 不在等待对账状态:${effect.status}`)
  }
  if (effect.revision !== expectedRevision) {
    throw new Error(`stale_revision: EffectRecord 已从 ${expectedRevision} 更新到 ${effect.revision}`)
  }
  const confirmsApplied = resolution === 'confirmed_applied'
  const confirmation = await showEffectResolutionConfirmation(
    sender,
    snapshot,
    effect,
    resolution,
    context,
    note
  )
  if (!confirmation) return { snapshot }
  const resolved = await context.resolveTaskEffect(snapshotId, effectId, expectedRevision, resolution, note)
  if (confirmsApplied && isManagedWorktreeEffect(effect)) {
    context.updateWorktreeState(effect.target.sessionId, effect.target.registryRecord.state)
  }
  return resolved
}

function validateResolutionInput(
  snapshotId: string,
  effectId: string,
  expectedRevision: number,
  resolution: EffectResolution
): void {
  if (typeof snapshotId !== 'string' || !snapshotId.trim()) throw new Error('必须指定任务快照 ID')
  if (typeof effectId !== 'string' || !effectId.trim()) throw new Error('必须指定 EffectRecord ID')
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error('必须指定有效的 EffectRecord revision')
  }
  if (!['confirmed_applied', 'confirmed_not_applied', 'abandoned_by_user'].includes(resolution)) {
    throw new Error('无效的效果处置类型')
  }
}

async function showEffectResolutionConfirmation(
  sender: WebContents,
  snapshot: TaskSnapshotRecord,
  effect: EffectRecord,
  resolution: EffectResolution,
  context: EffectResolutionContext,
  note?: string
): Promise<boolean> {
  const confirmsApplied = resolution === 'confirmed_applied'
  const abandoned = resolution === 'abandoned_by_user'
  const options = {
    type: 'warning' as const,
    title: '确认外部效果状态',
    message: abandoned ? '放弃本次操作并保持禁止重放？' : confirmsApplied ? '确认该外部操作已经执行？' : '确认该外部操作没有执行？',
    detail: [
      `工具: ${effect.toolName}`,
      `目标: ${context.describeTarget(effect)}`,
      `意图: ${context.describeIntent(snapshot, effect)}`,
      `核对版本: ${effect.revision} · 目标摘要: ${effect.targetDigest}`,
      note ? `核对说明: ${note.trim()}` : '',
      effect.error ? `当前证据: ${effect.error}` : '',
      abandoned ? '记录为人工放弃，不表示外部操作未执行，不授予重试权限，也不会自动续跑。' : confirmsApplied
        ? '确认后会把效果记为已执行，不会再次执行。'
        : '确认后会生成重试授权，后续可能再次产生该外部副作用。'
    ].filter(Boolean).join('\n'),
    buttons: ['取消', abandoned ? '放弃本次操作' : confirmsApplied ? '确认已执行' : '确认未执行并允许重试'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    checkboxLabel: '我已核对上方工具、目标和当前证据',
    checkboxChecked: false
  }
  const parent = BrowserWindow.fromWebContents(sender)
  const confirmation = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  return confirmation.response === 1 && confirmation.checkboxChecked === true
}

function isManagedWorktreeEffect(effect: EffectRecord): effect is EffectRecord & {
  target: Extract<EffectRecord['target'], { kind: 'git_worktree_create' | 'git_worktree_remove' }>
} {
  return effect.target.kind === 'git_worktree_create' || effect.target.kind === 'git_worktree_remove'
}
