import { existsSync, opendirSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import type { MigrationHistory, MigrationHistoryEntry, MigrationRollbackPreview } from '../shared/migration-types'
import { readMigrationContract, type MigrationContractJournal } from './migration-contract'
import { assertNoSymlinkWithin, readSafeFile, sha256, targetFingerprint } from './migration-safety'

const ID = /^[A-Za-z0-9._-]{1,120}$/
const FINGERPRINT = /^(?:missing|(?:file|dir):[a-f0-9]{64})$/
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('迁移备份格式无效。')
  return value as Record<string, unknown>
}
function contractAt(root: string, backupId: string): MigrationContractJournal {
  if (!ID.test(backupId)) throw new Error('迁移备份编号无效。')
  const path = join(resolve(root), backupId, 'contract.json')
  assertNoSymlinkWithin(resolve(root), path)
  const snapshot = readSafeFile(path, 1024 * 1024)
  const journal = readMigrationContract(root, backupId)
  if (JSON.stringify(journal) !== JSON.stringify(JSON.parse(snapshot.bytes.toString('utf8'))) || journal.backupId !== backupId || journal.migrationId !== backupId || journal.kind !== 'external-agent-assets' ||
    !Number.isFinite(journal.createdAt) || !Number.isFinite(journal.updatedAt) || journal.targets.length > 1000 ||
    journal.targets.some(target => !isAbsolute(target.path) || /[\0\r\n]/.test(target.path) || !FINGERPRINT.test(target.beforeFingerprint) || target.afterFingerprint !== undefined && !FINGERPRINT.test(target.afterFingerprint))) throw new Error('迁移记录身份或目标无效。')
  return journal
}

/** Reads durable metadata only; no backup contents or imported credentials reach the renderer. */
export function listMigrationHistory(root: string): MigrationHistory {
  if (!existsSync(root)) return { entries: [], truncated: false }
  assertNoSymlinkWithin(dirname(resolve(root)), resolve(root))
  const directory = opendirSync(root), entries: MigrationHistoryEntry[] = []
  let examined = 0, truncated = false
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (++examined > 2000) { truncated = true; break }
      if (!entry.isDirectory() || !ID.test(entry.name) || !existsSync(join(root, entry.name, 'contract.json'))) continue
      try {
        const journal = contractAt(root, entry.name)
        entries.push({ backupId: entry.name, state: journal.state, createdAt: journal.createdAt, updatedAt: journal.updatedAt,
          targetPaths: journal.targets.map(target => target.path), canReviewRollback: journal.state === 'committed' || journal.state === 'rollback_pending',
          ...(['prepared', 'backup_verified', 'applying'].includes(journal.state) ? { message: '导入未完成，请先在恢复中心核对原操作。' } : {}) })
      } catch { entries.push({ backupId: entry.name, state: 'invalid', targetPaths: [], canReviewRollback: false, message: '此导入记录无法校验，未读取或恢复目标。' }) }
    }
  } finally { directory.closeSync() }
  entries.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
  return { entries: entries.slice(0, 100), truncated: truncated || entries.length > 100 }
}

export function previewMigrationRollback(root: string, backupId: string): MigrationRollbackPreview {
  const result: MigrationRollbackPreview = { backupId, targetPaths: [], canRollback: false, message: '' }
  try {
    const journal = contractAt(root, backupId)
    result.targetPaths = journal.targets.map(target => target.path)
    if (journal.state !== 'committed' && journal.state !== 'rollback_pending') throw new Error(journal.state === 'rolled_back' ? '此导入已恢复。' : '原导入操作尚未完成，请先在恢复中心核对。')
    const directory = join(resolve(root), backupId), path = join(directory, 'manifest.json')
    assertNoSymlinkWithin(resolve(root), path)
    const snapshot = readSafeFile(path, 1024 * 1024), manifest = object(JSON.parse(snapshot.bytes.toString('utf8')))
    if (manifest.version !== 1 || manifest.backupId !== backupId || manifest.reason !== 'apply' || !Array.isArray(manifest.targets) || manifest.targets.length !== journal.targets.length) throw new Error('迁移备份清单与原记录不一致。')
    const observations: Array<{ path: string; current: string; backup: string }> = [], seen = new Set<string>()
    for (const raw of manifest.targets) {
      const target = object(raw), contractTarget = journal.targets.find(item => item.path === target.targetPath)
      if (!contractTarget || seen.has(contractTarget.path) || target.beforeFingerprint !== contractTarget.beforeFingerprint || typeof target.existed !== 'boolean' ||
        (target.existed ? target.beforeFingerprint === 'missing' : target.beforeFingerprint !== 'missing')) throw new Error('迁移备份目标身份不一致。')
      seen.add(contractTarget.path)
      assertNoSymlinkWithin(parse(contractTarget.path).root, contractTarget.path)
      const current = targetFingerprint(contractTarget.path)
      if (journal.state === 'committed' ? !target.afterFingerprint || target.afterFingerprint !== contractTarget.afterFingerprint || current !== target.afterFingerprint
        : current !== contractTarget.beforeFingerprint && current !== contractTarget.afterFingerprint) throw new Error('导入后的目标已改变；不会覆盖这些修改，请先核对。')
      let backup = 'missing'
      if (target.existed) {
        if (typeof target.backupPath !== 'string' || !['file', 'directory'].includes(String(target.kind))) throw new Error('导入前备份不完整。')
        const backupPath = resolve(directory, target.backupPath), rel = relative(directory, backupPath)
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('备份路径超出原记录。')
        assertNoSymlinkWithin(directory, backupPath)
        backup = targetFingerprint(backupPath)
        if (backup !== target.beforeFingerprint) throw new Error('导入前备份已改变，无法安全恢复。')
      }
      observations.push({ path: contractTarget.path, current, backup })
    }
    return { ...result, canRollback: true, reviewDigest: sha256(JSON.stringify({ journal, manifestDigest: snapshot.digest, observations })), message: '将恢复以下目标到本次导入前的内容；当前状态会另存为安全备份。' }
  } catch (cause) { return { ...result, message: cause instanceof Error ? cause.message : '无法校验导入备份。' } }
}

export function assertMigrationRollbackReview(root: string, backupId: string, reviewDigest: unknown): void {
  const current = previewMigrationRollback(root, backupId)
  if (!current.canRollback || !reviewDigest || current.reviewDigest !== reviewDigest) throw new Error(current.canRollback ? '恢复预览已变化，请重新核对目标。' : current.message)
}
