import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, isAbsolute, relative } from 'node:path'
import type { MigrationApplyInput, MigrationApplyResult, MigrationScan } from '../shared/migration-types'
import type { MigrationSubscription, MigrationSubscriptionPreview } from '../shared/migration-subscription-types'
import type { StoredMigrationScan } from './migration-scan-store'
import { assertNoSymlinkWithin, readSafeFile, readSafeDirectory, targetFingerprint, safeRulePreview } from './migration-safety'
import { writeDurableFileSync } from './durable-file'

interface StoredSubscription extends MigrationSubscription { sourceRoot: string; targetRoot: string }
interface ImportedSource extends StoredSubscription { importedAt: number }
interface Host {
  root: string
  scan(cwd?: string): MigrationScan
  apply(input: MigrationApplyInput, assertCurrent: () => void): Promise<MigrationApplyResult>
}
const kinds = new Set(['rules', 'mcp', 'config', 'skill', 'prompt'])
const statuses = new Set(['unchanged', 'changed', 'conflict', 'unavailable', 'applying', 'needs_reconciliation'])
function boundedString(value: unknown, maximum: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\0\r\n]/.test(value) }
function inside(root: string, path: string): boolean { const child = relative(root, path); return child !== '..' && !child.startsWith('../') && !child.startsWith('..\\') && !isAbsolute(child) }

/** Explicit opt-in watches metadata only. A detected change never writes a target. */
export class MigrationSubscriptions {
  private imported = new Map<string, ImportedSource[]>()
  private previews = new Map<string, MigrationSubscriptionPreview & { scanId: string }>()
  private applying = new Set<string>()
  private timer?: NodeJS.Timeout
  constructor(private host: Host) {}
  start(): void { if (!this.timer) { this.timer = setInterval(() => { try { this.check() } catch { /* surfaced by the settings read */ } }, 60_000); this.timer.unref() } }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.previews.clear(); this.imported.clear() }
  remember(stored: StoredMigrationScan | undefined, result: MigrationApplyResult): string[] {
    if (!stored || !result.ok || result.status !== 'applied' || !result.backupId) return []
    const rows: ImportedSource[] = []
    for (const applied of result.applied) {
      const source = stored.assets.get(applied.assetId)
      if (!source || !kinds.has(source.asset.kind) || source.readSourceDigest || !source.targetRoot || !source.targetPath || source.asset.risk === 'blocked') continue
      try {
        assertNoSymlinkWithin(source.sourceRoot, source.sourcePath); assertNoSymlinkWithin(source.targetRoot, source.targetPath)
        rows.push({ id: randomUUID(), revision: 1, assetId: source.asset.id, name: source.asset.name, kind: source.asset.kind,
          cwd: stored.result.cwd, sourceRoot: source.sourceRoot, targetRoot: source.targetRoot, sourcePath: source.sourcePath, targetPath: source.targetPath,
          sourceDigest: source.asset.sourceDigest, targetFingerprint: targetFingerprint(source.targetPath), previousPreview: safeRulePreview(source.asset.preview, 1000),
          enabled: true, status: 'unchanged', createdAt: Date.now(), backupId: result.backupId, importedAt: Date.now() })
      } catch { /* Never weaken an import receipt to create an unsafe watch. */ }
    }
    this.imported.set(result.backupId, rows)
    for (const [key, values] of this.imported) if (!values.length || Date.now() - values[0].importedAt > 30 * 60_000) this.imported.delete(key)
    while (this.imported.size > 20) this.imported.delete(this.imported.keys().next().value!)
    return rows.map(row => row.assetId)
  }
  list(): MigrationSubscription[] { return this.read().map(row => this.view(row)) }
  subscribe(backupId: string, assetIds: string[]): MigrationSubscription[] {
    const sources = this.imported.get(backupId)
    if (!sources?.length || Date.now() - sources[0].importedAt > 30 * 60_000) throw new Error('本次导入的订阅依据已过期，请重新扫描并确认导入。')
    if (!Array.isArray(assetIds) || !assetIds.length || assetIds.length > 50 || assetIds.some(id => typeof id !== 'string')) throw new Error('请选择本次已导入的文件或技能。')
    const rows = this.read()
    for (const id of new Set(assetIds)) {
      const source = sources.find(item => item.assetId === id)
      if (!source) throw new Error('选项不属于本次可订阅的导入资产。')
      const existing = rows.find(row => row.assetId === id && row.targetPath === source.targetPath)
      if (existing) {
        if (existing.status === 'applying' || existing.status === 'needs_reconciliation') throw new Error('原订阅操作仍待核对。')
        Object.assign(existing, { ...source, id: existing.id, revision: existing.revision + 1 })
      } else { if (rows.length >= 50) throw new Error('最多订阅 50 个导入来源。'); rows.push({ ...source }) }
    }
    this.save(rows); return this.list()
  }
  setEnabled(id: string, revision: number, enabled: boolean): MigrationSubscription {
    if (typeof enabled !== 'boolean') throw new Error('订阅状态无效。')
    const rows = this.read(), row = this.require(rows, id, revision)
    row.enabled = enabled; row.revision++
    for (const [key, preview] of this.previews) if (preview.subscriptionId === id) this.previews.delete(key)
    this.save(rows); return this.view(row)
  }
  check(): MigrationSubscription[] {
    const rows = this.read()
    for (const row of rows) {
      if (!row.enabled || ['applying', 'needs_reconciliation'].includes(row.status)) continue
      this.inspect(row); row.checkedAt = Date.now()
    }
    this.save(rows); return rows.map(row => this.view(row))
  }
  preview(id: string, revision: number): MigrationSubscriptionPreview {
    const rows = this.read(), row = this.require(rows, id, revision)
    this.assertEnabled(row)
    if (this.applying.has(row.id) || ['applying', 'needs_reconciliation'].includes(row.status)) throw new Error('原更新操作仍在执行或待核对，不能重新预览或提交。')
    this.inspect(row)
    if (row.status !== 'changed') throw new Error(row.message ?? '来源没有可应用的变化。')
    const scan = this.host.scan(row.cwd)
    const asset = scan.assets.find(asset => asset.id === row.assetId && asset.path === row.sourcePath && asset.targetPath === row.targetPath)
    if (!asset?.importable || asset.risk === 'blocked') throw new Error('更新后的来源不能安全导入，请在导入页面重新审阅。')
    const action = asset.supportedActions.includes('replace') ? 'replace' : asset.supportedActions.includes('import') ? 'import' : undefined
    if (!action || asset.sourceDigest === row.sourceDigest) throw new Error('没有可导入的来源变化。')
    const preview: MigrationSubscriptionPreview & { scanId: string } = { id: randomUUID(), subscriptionId: id, revision, before: row.previousPreview, after: asset, sourceDigest: asset.sourceDigest,
      expiresAt: Date.now() + 5 * 60_000, action, scanId: scan.scanId }
    for (const [key, previous] of this.previews) if (previous.expiresAt < Date.now() || previous.subscriptionId === id) this.previews.delete(key)
    this.previews.set(preview.id, preview)
    this.save(rows)
    const { scanId: _scan, ...view } = preview; return view
  }
  async apply(previewId: string): Promise<MigrationApplyResult> {
    const preview = this.previews.get(previewId)
    if (!preview || preview.expiresAt <= Date.now()) throw new Error('来源更新预览已过期，请重新预览。')
    const rows = this.read(), row = this.require(rows, preview.subscriptionId, preview.revision)
    this.assertEnabled(row)
    if (this.applying.has(row.id) || ['applying', 'needs_reconciliation'].includes(row.status)) throw new Error('原更新操作仍在执行或待核对，不能重复提交。')
    this.assertUnchanged(row, preview)
    row.status = 'applying'; this.save(rows); this.applying.add(row.id); this.previews.delete(previewId)
    try {
      const result = await this.host.apply({ scanId: preview.scanId, decisions: [{ assetId: row.assetId, action: preview.action }] }, () => {
        const current = this.require(this.read(), row.id, preview.revision)
        this.assertEnabled(current); this.assertUnchanged(current, preview)
      })
      const latest = this.read(), current = latest.find(item => item.id === row.id)!
      if (result.ok && result.status === 'applied') {
        current.sourceDigest = preview.sourceDigest; current.targetFingerprint = targetFingerprint(current.targetPath)
        current.previousPreview = safeRulePreview(preview.after.preview, 1000); current.backupId = result.backupId ?? current.backupId
        current.status = 'unchanged'; current.message = undefined; current.revision++
      } else { current.status = 'needs_reconciliation'; current.message = '更新结果未确认，请从导入历史或恢复中心核对原操作；不会自动重发。' }
      this.save(latest); return result
    } catch (error) {
      const latest = this.read(), current = latest.find(item => item.id === row.id)
      if (current) { current.status = 'needs_reconciliation'; current.message = '更新未能确认，请核对原操作；不会自动重发。'; this.save(latest) }
      throw error
    } finally { this.applying.delete(row.id) }
  }
  private assertUnchanged(row: StoredSubscription, preview: MigrationSubscriptionPreview): void {
    assertNoSymlinkWithin(row.sourceRoot, row.sourcePath); assertNoSymlinkWithin(row.targetRoot, row.targetPath)
    if (this.sourceDigest(row) !== preview.sourceDigest || targetFingerprint(row.targetPath) !== row.targetFingerprint) throw new Error('来源或导入目标已变化，请重新扫描；未覆盖当前文件。')
  }
  private sourceDigest(row: StoredSubscription): string {
    assertNoSymlinkWithin(row.sourceRoot, row.sourcePath)
    return row.kind === 'skill' ? readSafeDirectory(row.sourcePath, { maxFiles: 200, maxBytes: 5 * 1024 * 1024, maxDepth: 12 }).digest : readSafeFile(row.sourcePath, 512 * 1024).digest
  }
  private inspect(row: StoredSubscription): void {
    try {
      assertNoSymlinkWithin(row.targetRoot, row.targetPath)
      if (targetFingerprint(row.targetPath) !== row.targetFingerprint) { row.status = 'conflict'; row.message = '导入后的目标已被修改或回滚，请重新扫描合并，订阅不会覆盖它。'; return }
      row.status = this.sourceDigest(row) === row.sourceDigest ? 'unchanged' : 'changed'
      row.message = row.status === 'changed' ? '来源有更新，预览并确认后才会应用。' : undefined
    } catch { row.status = 'unavailable'; row.message = '来源或目标不可读取、已移动，或不再满足文件边界。' }
  }
  private assertEnabled(row: StoredSubscription): void { if (!row.enabled) throw new Error('此来源订阅已关闭。') }
  private require(rows: StoredSubscription[], id: string, revision: number): StoredSubscription {
    const row = rows.find(item => item.id === id)
    if (!row || row.revision !== revision) throw new Error('订阅已变化，请刷新。')
    return row
  }
  private view(row: StoredSubscription): MigrationSubscription { const { sourceRoot: _s, targetRoot: _t, ...view } = row; return view }
  private read(): StoredSubscription[] {
    const file = join(this.host.root, 'migration-subscriptions.json')
    if (!existsSync(file)) return []
    const data = JSON.parse(readSafeFile(file, 1024 * 1024).bytes.toString('utf8'))
    if (!data || typeof data !== 'object' || data.schemaVersion !== 1 || !Array.isArray(data.rows) || data.rows.length > 50) throw new Error('导入来源订阅记录无效。')
    const ids = new Set<string>()
    for (const row of data.rows as StoredSubscription[]) {
      if (!row || !boundedString(row.id, 200) || ids.has(row.id) || !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.enabled !== 'boolean'
        || ![row.sourceRoot, row.sourcePath, row.targetRoot, row.targetPath].every(value => boundedString(value, 8192) && isAbsolute(value))
        || !inside(row.sourceRoot, row.sourcePath) || !inside(row.targetRoot, row.targetPath)
        || row.cwd !== undefined && (!boundedString(row.cwd, 8192) || !isAbsolute(row.cwd))
        || !boundedString(row.assetId, 512) || !boundedString(row.name, 2000) || !boundedString(row.backupId, 200)
        || typeof row.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(row.sourceDigest)
        || typeof row.targetFingerprint !== 'string' || !/^(?:missing|(?:file|dir):[a-f0-9]{64})$/.test(row.targetFingerprint)
        || typeof row.previousPreview !== 'string' || row.previousPreview.length > 1100
        || !Number.isFinite(row.createdAt) || row.createdAt < 0 || row.checkedAt !== undefined && (!Number.isFinite(row.checkedAt) || row.checkedAt < 0)
        || row.message !== undefined && (typeof row.message !== 'string' || row.message.length > 2000)
        || !kinds.has(row.kind) || !statuses.has(row.status)) throw new Error('导入来源订阅记录无效。')
      ids.add(row.id)
      if (row.status === 'applying' && !this.applying.has(row.id)) { row.status = 'needs_reconciliation'; row.message = '上次更新结果待核对；不会在重启后重发。' }
    }
    return data.rows
  }
  private save(rows: StoredSubscription[]): void { writeDurableFileSync(join(this.host.root, 'migration-subscriptions.json'), JSON.stringify({ schemaVersion: 1, rows }, null, 2), { mode: 0o600 }) }
}
