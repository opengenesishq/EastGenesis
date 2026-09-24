import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { PluginCatalogDocument, PluginCatalogEntry, PluginCatalogPreparationView, PluginCatalogSelection, PluginCatalogSource, PluginCatalogView } from '../../shared/plugin-catalog-types'
import type { PluginInstallResult } from '../../shared/plugin-types'
import { scanPluginRegistry } from '../pluginRegistry'
import { buildManagedPluginEffectTarget, pluginInstallToolInput, preparePluginInstall, snapshotPluginDirectory, type ManagedPluginInstallTarget, type PreparedPluginInstall } from './plugin-directory-effect'
import { extractCatalogZip } from './catalog-archive'
import { catalogDirectory, catalogRead, catalogRows, catalogWrite, discardCatalogPayload } from './catalog-files'
import { catalogHttpsTransport, readCatalogBytes, type CatalogTransport } from './catalog-fetch'
import { archiveDigest, catalogDigest, catalogHash, catalogId, catalogRecord, catalogText, catalogUrl, CATALOG_LIMITS, parseCatalog, parseCatalogSelection } from './catalog-protocol'
import { catalogInstallation, type CatalogInstallation } from './catalog-installation'

interface SourceRecord extends PluginCatalogSource { schemaVersion: 1; document?: PluginCatalogDocument; changedVersions: string[]; seenVersions: Record<string, string> }
interface PreparationRecord extends PluginCatalogPreparationView {
  schemaVersion: 1; kind: PluginCatalogEntry['kind']; prepared?: PreparedPluginInstall; target?: ManagedPluginInstallTarget
  intentDigest?: string
}
export class PluginCatalogService {
  readonly root: string
  private readonly sourceRoot: string
  private readonly preparationRoot: string
  private readonly payloadRoot: string
  private readonly transport: CatalogTransport
  private readonly installation: CatalogInstallation
  private readonly downloads = new Map<string, AbortController>()
  private readonly refreshing = new Set<string>()
  private readonly installing = new Set<string>()
  constructor(readonly userData: string, readonly pluginsRoot: string, options: { transport?: CatalogTransport; installation?: CatalogInstallation } = {}) {
    this.root = catalogDirectory(join(userData, 'plugin-catalog'))
    this.sourceRoot = catalogDirectory(join(this.root, 'sources'))
    this.preparationRoot = catalogDirectory(join(this.root, 'preparations'))
    this.payloadRoot = catalogDirectory(join(this.root, 'payloads'))
    this.transport = options.transport ?? catalogHttpsTransport
    this.installation = options.installation ?? catalogInstallation(userData)
    // A restarted app never restarts a download or an installation automatically.
    for (const file of catalogRows(this.preparationRoot)) {
      const row = this.readPreparation(file.slice(0, -5))
      if (row.state === 'downloading') { row.state = 'failed'; row.error = '下载准备被中断，请重新准备。'; this.save(row); this.discard(row.id) }
      if (row.state === 'installing') { row.state = 'waiting_reconciliation'; row.error = '原安装被中断，需核对原操作。'; this.save(row) }
    }
  }
  get(): PluginCatalogView {
    const sources = this.sources(), entries: PluginCatalogEntry[] = []
    for (const source of sources) if (source.enabled && source.document && source.snapshotDigest) for (const item of source.document.packages) for (const release of item.releases) {
      entries.push({ id: item.id, name: item.name, summary: item.summary, kind: item.kind, sourceId: source.id, sourceName: source.name, sourceUrl: source.url,
        snapshotDigest: source.snapshotDigest, release, changedVersion: source.changedVersions.includes(`${item.id}@${release.version}`) })
    }
    return { sources: sources.map(({ document: _document, schemaVersion: _schema, changedVersions: _changed, seenVersions: _seen, ...view }) => view), entries,
      preparations: catalogRows(this.preparationRoot).map(file => this.view(this.readPreparation(file.slice(0, -5)))).sort((a, b) => b.createdAt - a.createdAt) }
  }
  add(input: unknown): PluginCatalogView {
    const row = catalogRecord(input, ['name', 'url']), name = catalogText(row.name, 120, '源名称'), url = catalogUrl(row.url), sources = this.sources()
    if (sources.length >= CATALOG_LIMITS.sources || sources.some(source => source.url === url)) throw new Error('目录源重复或已达 10 个上限。')
    this.saveSource({ schemaVersion: 1, id: randomUUID(), name, url, enabled: true, changedVersions: [], seenVersions: {} }); return this.get()
  }
  enabled(id: unknown, value: unknown): PluginCatalogView {
    if (typeof value !== 'boolean') throw new Error('源启用状态无效。')
    const source = this.source(id); source.enabled = value; this.saveSource(source)
    if (!value) this.invalidateSource(source.id); return this.get()
  }
  remove(id: unknown): PluginCatalogView {
    const source = this.source(id)
    // Exact one-record deletion; installed packages remain managed by the registry.
    discardCatalogPayload(this.sourceRoot, this.sourcePath(source.id)); this.invalidateSource(source.id); return this.get()
  }
  async refresh(id: unknown): Promise<PluginCatalogView> {
    const source = this.source(id)
    if (!source.enabled) throw new Error('请先启用此目录源。')
    if (this.refreshing.has(source.id)) throw new Error('此目录正在刷新。')
    this.refreshing.add(source.id)
    try {
      const bytes = await readCatalogBytes(this.transport, source.url, CATALOG_LIMITS.catalogBytes, new AbortController().signal)
      const document = parseCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), source.url)
      const current = this.source(source.id); if (!current.enabled || current.url !== source.url) throw new Error('目录源在刷新期间已改变。')
      const changedVersions: string[] = [], seenVersions = { ...current.seenVersions }
      for (const item of document.packages) for (const release of item.releases) {
        const key = `${item.id}@${release.version}`, old = seenVersions[key]
        if (old && old !== release.archiveSha256) changedVersions.push(key)
        seenVersions[key] ??= release.archiveSha256
      }
      if (Object.keys(seenVersions).length > 10000) throw new Error('源历史版本过多，请建立新的目录源。')
      this.saveSource({ ...current, document, snapshotDigest: catalogDigest(document), fetchedAt: Date.now(), error: undefined, changedVersions, seenVersions })
      this.invalidateSource(source.id, true)
    } catch (error) {
      const current = catalogRead<SourceRecord>(this.sourcePath(source.id), 8 * 1024 * 1024)
      if (current?.enabled) this.saveSource({ ...current, error: message(error) })
      throw new Error(message(error))
    } finally { this.refreshing.delete(source.id) }
    return this.get()
  }
  prepare(input: unknown): PluginCatalogPreparationView {
    const selection = parseCatalogSelection(input), entry = this.entry(selection)
    // One pending intent for one exact release. Repeated clicks retain the original id.
    const existing = this.get().preparations.find(row => catalogDigest(row.selection) === catalogDigest(selection) && ['downloading', 'ready', 'installing', 'waiting_reconciliation'].includes(row.state))
    if (existing) return existing
    if (this.downloads.size >= 2) throw new Error('已有两个下载准备正在进行。')
    const id = randomUUID(), row: PreparationRecord = { schemaVersion: 1, id, operationId: id, selection, name: entry.name, kind: entry.kind,
      sourceUrl: entry.sourceUrl, archiveUrl: entry.release.archiveUrl, archiveBytes: entry.release.archiveBytes, state: 'downloading', createdAt: Date.now(), updatedAt: Date.now() }
    this.save(row)
    const controller = new AbortController(); this.downloads.set(id, controller)
    void this.download(row, controller.signal).catch(() => { /* Durable incomplete state is surfaced on next read/restart. */ }).finally(() => this.downloads.delete(id))
    return this.view(row)
  }
  cancel(id: unknown): PluginCatalogPreparationView {
    const row = this.readPreparation(catalogId(id))
    if (!['downloading', 'ready', 'failed', 'cancelled'].includes(row.state)) throw new Error('安装已开始，请核对原操作，不能取消后重发。')
    row.state = 'cancelled'; row.error = undefined; this.save(row)
    const controller = this.downloads.get(row.id); controller?.abort()
    if (!controller) this.discard(row.id)
    return this.view(row)
  }
  async install(input: unknown): Promise<PluginCatalogPreparationView> {
    const value = catalogRecord(input, ['id', 'previewDigest', 'overwrite']), row = this.readPreparation(catalogId(value.id))
    catalogHash(value.previewDigest)
    if (typeof value.overwrite !== 'boolean') throw new Error('覆盖确认无效。')
    this.assertIntent(row)
    if (row.preview!.digest !== value.previewDigest || row.preview!.overwrite && !value.overwrite) throw new Error('请确认当前预览及覆盖范围。')
    if (row.state === 'installed') return this.view(row)
    if (['installing', 'waiting_reconciliation'].includes(row.state)) return this.reconcile(row.id)
    if (row.state !== 'ready') throw new Error('准备记录不可安装，请重新准备。')
    this.entry(row.selection)
    if (snapshotPluginDirectory(row.prepared!.sourcePath).digest !== row.prepared!.expected.digest) throw new Error('准备文件在预览后改变，请重新准备。')
    if (this.installing.size) throw new Error('另一项插件安装正在处理，请等待原操作。')
    this.installing.add(row.id)
    // Durable intent barrier precedes the first possible managed-directory mutation.
    row.state = 'installing'; this.save(row)
    try {
      const result = await this.installation.install(row.prepared!, row.target!)
      this.acceptResult(row, result)
    } catch (error) {
      row.state = 'waiting_reconciliation'; row.error = message(error); this.save(row)
    } finally { this.installing.delete(row.id) }
    return this.view(row)
  }
  async reconcile(id: unknown): Promise<PluginCatalogPreparationView> {
    const row = this.readPreparation(catalogId(id)); this.assertIntent(row)
    if (this.installing.has(row.id)) return this.view(row)
    if (row.state === 'installed' || row.state === 'failed' || row.state === 'reverted') return this.view(row)
    if (!['installing', 'waiting_reconciliation'].includes(row.state)) throw new Error('这项准备尚未开始安装。')
    this.installing.add(row.id)
    try { this.acceptResult(row, await this.installation.reconcile(row.operationId, row.target!)) }
    catch (error) { row.state = 'waiting_reconciliation'; row.error = message(error); this.save(row) }
    finally { this.installing.delete(row.id) }
    return this.view(row)
  }
  private async download(row: PreparationRecord, signal: AbortSignal): Promise<void> {
    try {
      const bytes = await readCatalogBytes(this.transport, row.archiveUrl, CATALOG_LIMITS.archiveBytes, signal, row.archiveBytes)
      signal.throwIfAborted(); this.entry(row.selection)
      if (archiveDigest(bytes) !== row.selection.archiveSha256) throw new Error('插件包 SHA-256 与固定版本不一致。')
      const payload = catalogDirectory(join(this.payloadRoot, row.id)), packageRoot = join(payload, row.selection.packageId)
      writeFileSync(join(payload, 'package.zip'), bytes, { flag: 'wx', mode: 0o600 })
      await extractCatalogZip(bytes, packageRoot, signal)
      signal.throwIfAborted(); this.entry(row.selection)
      const registry = scanPluginRegistry([packageRoot], { maxFiles: CATALOG_LIMITS.files, maxDepth: CATALOG_LIMITS.depth, maxReadBytes: 1024 * 1024 })
      if (!registry.items.length || registry.truncated || registry.diagnostics.length || registry.items.some(item => !item.contentDigest || item.trust.status === 'invalid')) throw new Error('插件包无法完整识别或审核，请检查包格式。')
      if (!registry.items.some(item => item.kind === row.kind)) throw new Error('插件包内容与目录声明的类型不同。')
      const top = registry.items.find(item => item.kind === 'plugin') ?? registry.items.find(item => item.kind === row.kind)
      if (top?.version && top.version !== row.selection.version) throw new Error('包内版本与所选版本不同。')
      const prepared = preparePluginInstall(packageRoot, this.pluginsRoot, true, row.operationId)
      if ('ok' in prepared) throw new Error(prepared.error ?? '插件包不能安装。')
      const target = buildManagedPluginEffectTarget(prepared.operationCwd, 'managed_plugin_install', pluginInstallToolInput(prepared))
      if (target.kind !== 'managed_plugin_install') throw new Error('安装目标类型无效。')
      row.prepared = prepared; row.target = target
      row.preview = { digest: '', targetPath: join(target.rootPath, target.pluginName), directoryDigest: prepared.expected.digest, files: prepared.expected.files, bytes: prepared.expected.bytes, overwrite: target.targetPreState === 'directory',
        items: registry.items.map(item => ({ name: item.name, kind: item.kind, version: item.version, contentDigest: item.contentDigest!, capabilities: item.capabilityManifest.capabilities })) }
      row.intentDigest = this.intentDigest(row); row.preview.digest = row.intentDigest
      if (this.readPreparation(row.id).state === 'cancelled') throw new Error('下载已取消。')
      row.state = 'ready'; row.error = undefined; this.save(row)
    } catch (error) {
      const current = this.readPreparation(row.id)
      if (current.state !== 'cancelled') { current.state = 'failed'; current.error = message(error); this.save(current) }
      this.discard(row.id)
    }
  }
  private acceptResult(row: PreparationRecord, result: PluginInstallResult): void {
    if (result.operationId !== row.operationId) throw new Error('安装回执不属于原操作。')
    row.result = result; row.error = result.error
    row.state = result.effectStatus === 'compensated' ? 'reverted' : result.effectStatus === 'waiting_reconciliation' ? 'waiting_reconciliation' : result.ok ? 'installed' : 'failed'
    this.save(row)
    if (row.state === 'installed' || row.state === 'reverted') this.discard(row.id)
  }
  private intentDigest(row: PreparationRecord): string {
    return catalogDigest({ id: row.id, operationId: row.operationId, selection: row.selection, sourceUrl: row.sourceUrl, archiveUrl: row.archiveUrl, archiveBytes: row.archiveBytes,
      prepared: row.prepared, target: row.target, preview: row.preview && { ...row.preview, digest: '' } })
  }
  private assertIntent(row: PreparationRecord): void {
    if (!row.prepared || !row.target || !row.preview || row.operationId !== row.id || row.intentDigest !== this.intentDigest(row) || row.preview.digest !== row.intentDigest
      || resolve(row.prepared.sourcePath) !== join(this.payloadRoot, row.id, row.selection.packageId) || row.prepared.transitionId !== row.operationId
      || resolve(row.prepared.rootPath) !== resolve(this.pluginsRoot) || row.target.rootPath !== row.prepared.rootPath) throw new Error('原安装预览或准备区身份无法核对。')
  }
  private entry(selection: PluginCatalogSelection): PluginCatalogEntry {
    const source = this.source(selection.sourceId)
    if (!source.enabled || !source.document || source.snapshotDigest !== selection.snapshotDigest) throw new Error('目录源或快照已变化，请重新选择版本。')
    const item = source.document.packages.find(item => item.id === selection.packageId), release = item?.releases.find(row => row.version === selection.version && row.archiveSha256 === selection.archiveSha256)
    if (!item || !release) throw new Error('固定版本已不属于当前目录快照。')
    return { id: item.id, name: item.name, summary: item.summary, kind: item.kind, sourceId: source.id, sourceName: source.name, sourceUrl: source.url, snapshotDigest: source.snapshotDigest, release, changedVersion: source.changedVersions.includes(`${item.id}@${release.version}`) }
  }
  private invalidateSource(id: string, onlyStale = false): void {
    for (const view of this.get().preparations) if (view.selection.sourceId === id && ['downloading', 'ready'].includes(view.state)) {
      if (onlyStale) { try { this.entry(view.selection); continue } catch { /* stale */ } }
      this.cancel(view.id)
    }
  }
  private sourcePath(id: string): string { return join(this.sourceRoot, `${catalogId(id)}.json`) }
  private source(id: unknown): SourceRecord {
    const key = catalogId(id), row = catalogRead<SourceRecord>(this.sourcePath(key), 8 * 1024 * 1024)
    if (!row || row.id !== key || row.schemaVersion !== 1 || typeof row.enabled !== 'boolean' || !row.seenVersions || !Array.isArray(row.changedVersions)) throw new Error('目录源不存在或记录损坏。')
    catalogUrl(row.url)
    if (row.document) { row.document = parseCatalog(row.document, row.url); if (catalogDigest(row.document) !== row.snapshotDigest) throw new Error('目录缓存摘要不一致。') }
    return row
  }
  private sources(): SourceRecord[] { return catalogRows(this.sourceRoot).map(file => this.source(file.slice(0, -5))) }
  private saveSource(row: SourceRecord): void { catalogWrite(this.sourcePath(row.id), row) }
  private readPreparation(id: string): PreparationRecord {
    const row = catalogRead<PreparationRecord>(join(this.preparationRoot, `${catalogId(id)}.json`))
    if (!row || row.schemaVersion !== 1 || row.id !== id || row.operationId !== id || !['downloading', 'ready', 'installing', 'installed', 'waiting_reconciliation', 'failed', 'cancelled', 'reverted'].includes(row.state)) throw new Error('安装准备记录不存在或损坏。')
    parseCatalogSelection(row.selection); return row
  }
  private save(row: PreparationRecord): void { row.updatedAt = Date.now(); catalogWrite(join(this.preparationRoot, `${catalogId(row.id)}.json`), row) }
  private discard(id: string): void { const path = join(this.payloadRoot, catalogId(id)); if (existsSync(path)) discardCatalogPayload(this.payloadRoot, path) }
  private view(row: PreparationRecord): PluginCatalogPreparationView {
    const { schemaVersion: _schema, prepared: _prepared, target: _target, intentDigest: _intent, kind: _kind, ...view } = row
    return view
  }
}
const message = (error: unknown): string => (error instanceof Error ? error.message : '插件目录操作失败。').slice(0, 500)
