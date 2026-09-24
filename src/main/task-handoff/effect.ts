import { readFileSync, lstatSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { EffectTarget } from '../../shared/effect-types'
import { confirmed, notApplied, unresolved, type EffectReconciliationResult } from '../task/effect-reconciliation-result'

type HandoffTarget = Extract<EffectTarget, { kind: 'task_handoff' }>
export function isTaskHandoffEffectTarget(value: unknown): value is HandoffTarget {
  if (!value || typeof value !== 'object') return false
  const target = value as HandoffTarget
  return target.kind === 'task_handoff' && ([target.sessionId, target.handoffId]).every(value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value)) &&
    [target.sourceHostId, target.targetHostId].every(value => typeof value === 'string' && /^host:[a-f0-9]{64}$/.test(value)) &&
    [target.bundleDigest, target.previewDigest].every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) && typeof target.rootDir === 'string' && isAbsolute(target.rootDir)
}
export function buildTaskHandoffEffectTarget(input: Record<string, unknown>): HandoffTarget {
  const target = { kind: 'task_handoff', ...input }
  if (!isTaskHandoffEffectTarget(target)) throw new Error('移交效果绑定无效。')
  return target
}
export function reconcileTaskHandoffEffectTarget(target: HandoffTarget): EffectReconciliationResult {
  try {
    const path = join(target.rootDir, 'private', 'task-handoff', 'journals', `${target.handoffId}.json`), info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('journal')
    const row = JSON.parse(readFileSync(path, 'utf8'))
    if (row.id !== target.handoffId || row.identity?.sessionId !== target.sessionId || row.sourceHostId !== target.sourceHostId || row.targetHostId !== target.targetHostId || row.header?.bundleDigest !== target.bundleDigest || row.previewDigest !== target.previewDigest) throw new Error('binding')
    if (row.state === 'committed' && row.releaseProof) return confirmed({ handoffId: row.id, proof: row.releaseProof }, '双端移交已确认，源端已停止执行。')
    if (row.state === 'cancelled' && !row.releaseProof) return notApplied({ handoffId: row.id }, '已在释放任务前取消。')
    return unresolved({ handoffId: row.id, reason: '请核对原移交回执，不会创建第二次交接。' })
  } catch { return unresolved({ reason: '原任务移交记录无法核对。' }) }
}
