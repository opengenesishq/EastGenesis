import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, normalize } from 'node:path'
import type { SessionMeta } from '../../shared/types'
import type { LocalSiteCatalog, LocalSiteOwner, LocalSitePublication, LocalSiteRegistration, LocalSiteResolution, LocalSiteView } from '../../shared/local-site-catalog-types'
import { writeDurableFile } from '../durable-file'
import { resolveExistingProjectPath } from '../utils/safe-project-path'

type Meta = Pick<SessionMeta, 'id' | 'createdAt' | 'cwd' | 'workspaceId' | 'goalId' | 'workItemId' | 'title' | 'status' | 'sideChat'>
interface StoredSite {
  id: string; name: string; sourcePath: string; kind: 'html' | 'directory'; owner: LocalSiteOwner; taskTitle: string; registeredAt: number
}
interface DeploymentDocument { owner: LocalSiteOwner; targets: Array<{ id: string; name: string; sourcePath: string }>; receipts: Array<LocalSitePublication & { targetId: string; sourcePath: string }> }
interface Host { root(): string; session(id: string): Meta | undefined; assertRead(id: string, path: string): void | Promise<void>; isExecuting?(receiptId: string): boolean }
const LIMIT = 2000
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const ownerValues = (owner: LocalSiteOwner): unknown[] => [owner.sessionId, owner.createdAt, owner.cwd, owner.workspaceId, owner.goalId, owner.workItemId]
export const localSiteTaskKey = (owner: LocalSiteOwner): string => digest(ownerValues(owner))
export function localSiteOwner(meta: Meta, cwd: string): LocalSiteOwner {
  return { sessionId: meta.id, createdAt: meta.createdAt, cwd, workspaceId: meta.workspaceId, goalId: meta.goalId, workItemId: meta.workItemId }
}
function siteId(owner: LocalSiteOwner, sourcePath: string): string { return digest([ownerValues(owner), sourcePath]) }

/** Local index and read-only projections of original deployment ledgers. No hosted site operations. */
export class LocalSiteCatalogService {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly host: Host) {}
  private file(): string { return join(this.host.root(), 'local-sites', 'catalog.json') }
  async register(input: LocalSiteRegistration): Promise<LocalSiteView> {
    const pending = this.queue.catch(() => undefined).then(async () => {
      validateRegistration(input)
      const meta = { ...this.live(input.sessionId) }, original = meta
      const path = await resolveExistingProjectPath(meta.cwd, input.path)
      const owner = localSiteOwner(meta, path.root), key = localSiteTaskKey(owner)
      await this.host.assertRead(meta.id, path.fullPath)
      const info = await lstat(path.fullPath)
      if (!info.isDirectory() && (!info.isFile() || !['.htm', '.html'].includes(extname(path.fullPath).toLowerCase()))) throw new Error('请选择 HTML 文件或静态构建目录。')
      if (info.isDirectory()) {
        const entry = await resolveExistingProjectPath(path.root, join(path.fullPath, 'index.html'))
        await this.host.assertRead(meta.id, entry.fullPath)
        if (!(await lstat(entry.fullPath)).isFile()) throw new Error('静态目录需要 index.html。')
      }
      await this.assertCurrent(original, key)
      const sites = await this.readIndex(), sourcePath = path.relativePath || '.', id = siteId(owner, sourcePath)
      const prior = sites.find(site => site.id === id)
      if (!prior && sites.length >= LIMIT) throw new Error('本机站点登记已达到 2000 项。')
      const row: StoredSite = { id, owner, sourcePath, kind: info.isDirectory() ? 'directory' : 'html',
        name: input.name?.trim() || prior?.name || basename(path.fullPath).slice(0, 160), taskTitle: meta.title.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1024) || meta.id,
        registeredAt: prior?.registeredAt ?? Date.now() }
      await this.assertCurrent(original, key)
      await writeDurableFile(this.file(), `${JSON.stringify({ version: 1, sites: [...sites.filter(site => site.id !== id), row] }, null, 2)}\n`)
      await this.assertCurrent(original, key)
      const deployments = await this.readDeployments()
      return this.project(row, 'registered', deployments.documents)
    })
    this.queue = pending
    return pending
  }
  async list(): Promise<LocalSiteCatalog> {
    const sites = await this.readIndex(), deployments = await this.readDeployments()
    const merged = new Map(sites.map(row => [row.id, { row, origin: 'registered' as LocalSiteView['origin'] }]))
    for (const document of deployments.documents) for (const target of document.targets) {
      const id = siteId(document.owner, target.sourcePath)
      if (merged.has(id)) continue
      if (merged.size >= LIMIT) { deployments.warnings.push('站点较多，本次最多展示 2000 项。'); break }
      merged.set(id, { origin: 'deployment', row: { id, owner: document.owner, sourcePath: target.sourcePath, kind: 'directory',
        name: target.name, taskTitle: document.owner.sessionId,
        registeredAt: Math.min(...document.receipts.filter(row => row.targetId === target.id && row.sourcePath === target.sourcePath).map(row => row.startedAt), document.owner.createdAt) } })
    }
    const projected: LocalSiteView[] = []
    for (const { row, origin } of merged.values()) projected.push(await this.project(row, origin, deployments.documents))
    return { sites: projected.sort((a, b) => (b.latestOperation?.startedAt ?? b.registeredAt) - (a.latestOperation?.startedAt ?? a.registeredAt)), warnings: [...new Set(deployments.warnings)] }
  }
  async resolve(id: string, revision: string): Promise<LocalSiteResolution> {
    if (!/^[a-f0-9]{64}$/.test(id) || !/^[a-f0-9]{64}$/.test(revision)) throw new Error('站点身份无效。')
    const site = (await this.list()).sites.find(row => row.id === id)
    if (!site || site.revision !== revision) throw new Error('站点记录或发布状态已变化，请刷新。')
    if (site.availability !== 'available') throw new Error(site.unavailableReason ?? '原任务或站点目录不可用。')
    const meta = { ...this.live(site.owner.sessionId) }, original = meta
    const path = await resolveExistingProjectPath(meta.cwd, site.sourcePath)
    if (localSiteTaskKey(localSiteOwner(meta, path.root)) !== site.taskKey) throw new Error('原任务归属已变化。')
    await this.host.assertRead(meta.id, path.fullPath)
    await this.assertCurrent(original, site.taskKey)
    return { siteId: id, sessionId: meta.id, path: site.sourcePath, kind: site.kind, taskKey: site.taskKey }
  }
  private live(id: string): Meta {
    const meta = this.host.session(id)
    if (!meta || meta.status === 'closed' || meta.sideChat) throw new Error('原任务已关闭、不可用或属于只读侧聊。')
    return meta
  }
  private async assertCurrent(original: Meta, expected: string): Promise<void> {
    const current = { ...this.live(original.id) }, key = localSiteTaskKey(localSiteOwner(current, await realpath(current.cwd)))
    const after = this.live(original.id)
    if (key !== expected || original.cwd !== current.cwd || localSiteTaskKey(localSiteOwner(current, current.cwd)) !== localSiteTaskKey(localSiteOwner(after, after.cwd))) throw new Error('登记或打开期间任务归属已变化，请重试。')
  }
  private async project(row: StoredSite, origin: LocalSiteView['origin'], documents: DeploymentDocument[]): Promise<LocalSiteView> {
    const taskKey = localSiteTaskKey(row.owner)
    const operations = documents.filter(document => localSiteTaskKey(document.owner) === taskKey).flatMap(document => {
      return document.receipts.filter(receipt => receipt.sourcePath === row.sourcePath).map(receipt => receipt.status === 'executing' && !this.host.isExecuting?.(receipt.receiptId)
        ? { ...receipt, status: 'needs_reconciliation' as const } : receipt)
    }).sort((a, b) => b.startedAt - a.startedAt)
    const lastConfirmedDeployment = operations.find(row => row.action === 'deploy' && row.status === 'confirmed'), latestOperation = operations[0]
    const unresolvedOperations = operations.filter(row => row.status === 'executing' || row.status === 'needs_reconciliation').length
    const meta = this.host.session(row.owner.sessionId)
    let sameOwner = false
    let availability: LocalSiteView['availability'] = 'available', unavailableReason: string | undefined
    if (!meta || meta.status === 'closed') { availability = 'task_closed'; unavailableReason = '原任务已关闭；保留本机记录和发布回执。' }
    else if (meta.sideChat) { availability = 'unavailable'; unavailableReason = '原任务属于只读侧聊。' }
    else {
      try {
        const cwd = await realpath(meta.cwd)
        if (localSiteTaskKey(localSiteOwner(meta, cwd)) !== taskKey) { availability = 'owner_changed'; unavailableReason = '原任务目录或归属已变化；不能沿用原站点操作。' }
        else {
          sameOwner = true
          const path = await resolveExistingProjectPath(cwd, row.sourcePath), info = await lstat(path.fullPath)
          if (row.kind === 'html' ? !info.isFile() : !info.isDirectory()) throw new Error('站点文件类型已变化。')
        }
      } catch { availability = 'missing_source'; unavailableReason = '原站点文件或目录不可用。' }
    }
    const view = { ...row, origin, taskKey, taskTitle: sameOwner && meta ? meta.title : row.taskTitle, availability, unavailableReason,
      lastConfirmedDeployment, latestOperation, unresolvedOperations }
    return { ...view, revision: digest(view) }
  }
  private async readIndex(): Promise<StoredSite[]> {
    const value = await readJson(this.file(), 4 * 1024 * 1024)
    if (value === undefined) return []
    const record = object(value)
    if (record.version !== 1 || !Array.isArray(record.sites) || record.sites.length > LIMIT) throw new Error('本地站点索引格式无效；未覆盖原文件。')
    const rows = record.sites.map(item => decodeSite(item)), ids = new Set(rows.map(row => row.id))
    if (ids.size !== rows.length) throw new Error('本地站点索引存在重复身份。')
    return rows
  }
  private async readDeployments(): Promise<{ documents: DeploymentDocument[]; warnings: string[] }> {
    const root = join(this.host.root(), 'site-deployments'), documents: DeploymentDocument[] = [], warnings: string[] = []
    const entries = await readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    for (const entry of entries.filter(item => item.isDirectory() && /^[a-f0-9]{64}$/.test(item.name)).slice(0, LIMIT)) {
      try {
        const value = await readJson(join(root, entry.name, 'state.json'), 32 * 1024 * 1024)
        if (value === undefined) continue
        const document = decodeDeployment(value)
        if (createHash('sha256').update(document.owner.sessionId).digest('hex') !== entry.name) throw new Error('部署记录归属与目录不一致。')
        documents.push(document)
      } catch { warnings.push('部分原部署记录无法读取；原文件保持保留。') }
    }
    if (entries.length > LIMIT) warnings.push('原部署记录较多，本次只读取前 2000 个任务目录。')
    return { documents, warnings }
  }
}

async function readJson(path: string, max: number): Promise<unknown | undefined> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw new Error('站点记录文件类型或大小无效。')
    const text = await readFile(path, 'utf8')
    if (Buffer.byteLength(text) > max) throw new Error('站点记录过大。')
    return JSON.parse(text)
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('站点记录格式无效。')
  return value as Record<string, unknown>
}
function text(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error('站点文字字段无效。')
  return value
}
function pathText(value: unknown): string {
  const path = text(value)
  if (isAbsolute(path) || path.includes('\\')) throw new Error('站点路径必须相对任务目录。')
  const normalized = normalize(path).split('\\').join('/')
  if (normalized === '..' || normalized.startsWith('../')) throw new Error('站点路径越界。')
  return normalized.replace(/\/$/, '') || '.'
}
function decodeOwner(value: unknown, legacy = false): LocalSiteOwner {
  const owner = object(value), cwd = text(owner.cwd)
  if (!isAbsolute(cwd) || !Number.isFinite(owner.createdAt) || Number(owner.createdAt) <= 0) throw new Error('站点任务归属无效。')
  return { sessionId: text(legacy ? owner.id : owner.sessionId, 256), createdAt: Number(owner.createdAt), cwd,
    ...(owner.workspaceId ? { workspaceId: text(owner.workspaceId, 256) } : {}),
    ...(owner.goalId ? { goalId: text(owner.goalId, 256) } : {}), ...(owner.workItemId ? { workItemId: text(owner.workItemId, 256) } : {}) }
}
function decodeSite(value: unknown): StoredSite {
  const row = object(value), owner = decodeOwner(row.owner), sourcePath = pathText(row.sourcePath)
  if (row.id !== siteId(owner, sourcePath) || !['html', 'directory'].includes(String(row.kind)) || !Number.isFinite(row.registeredAt)) throw new Error('站点身份无效。')
  return { id: String(row.id), name: text(row.name, 160), sourcePath, kind: row.kind as StoredSite['kind'], owner,
    taskTitle: text(row.taskTitle, 1024), registeredAt: Number(row.registeredAt) }
}
function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}
function decodeDeployment(value: unknown): DeploymentDocument {
  const data = object(value), owner = decodeOwner(data.owner, true)
  if (data.version !== 1 || !Array.isArray(data.targets) || !Array.isArray(data.receipts)) throw new Error('部署记录版本无效。')
  const targets = data.targets.map(value => { const target = object(value); return { id: text(target.id, 256), name: text(target.name, 160), sourcePath: pathText(target.outputDirectory) } })
  const receipts: DeploymentDocument['receipts'] = []
  for (const value of data.receipts) {
    const saved = object(value), row = object(saved.view)
    if (!['deploy', 'rollback'].includes(String(row.action)) || !['executing', 'confirmed', 'not_started', 'needs_reconciliation'].includes(String(row.status)) || !Number.isFinite(row.startedAt)) continue
    const targetId = text(row.targetId, 256)
    const preview = object(saved.preview), previewView = object(preview.view), target = object(previewView.target)
    if (row.sessionId !== owner.sessionId || previewView.sessionId !== owner.sessionId || localSiteTaskKey(decodeOwner(preview.owner, true)) !== localSiteTaskKey(owner) || target.id !== targetId) throw new Error('部署回执与原任务或目标不一致。')
    const sourcePath = pathText(target.outputDirectory)
    // Keep publications visible after removing the editable local target.
    if (!targets.some(target => target.id === targetId && target.sourcePath === sourcePath)) {
      targets.push({ id: targetId, name: text(row.targetName, 160), sourcePath })
    }
    const confirmed = row.status === 'confirmed' && row.verification === 'adapter_receipt' && typeof row.deploymentId === 'string' && safeUrl(row.url)
    receipts.push({ receiptId: text(row.id, 256), targetId, sourcePath, targetName: text(row.targetName, 160),
      action: row.action as LocalSitePublication['action'], status: row.status === 'confirmed' && !confirmed ? 'needs_reconciliation' : row.status as LocalSitePublication['status'],
      startedAt: Number(row.startedAt), ...(row.deploymentId ? { deploymentId: text(row.deploymentId, 1024) } : {}), ...(safeUrl(row.url) ? { url: safeUrl(row.url) } : {}) })
  }
  return { owner, targets, receipts }
}
function validateRegistration(input: LocalSiteRegistration): void {
  const value = object(input)
  if (Object.keys(value).some(key => !['sessionId', 'path', 'name'].includes(key))) throw new Error('不支持的站点登记字段。')
  text(input.sessionId, 256); text(input.path)
  if (input.name !== undefined) text(input.name, 160)
}
