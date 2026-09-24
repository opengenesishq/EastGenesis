import { randomUUID } from 'node:crypto'
import { lstat, realpath, rm } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import type { SessionMeta } from '../../shared/types'
import type { LocalSitePreview } from '../../shared/site-deployment-types'
import { resolveExistingProjectPath } from '../utils/safe-project-path'
import { freezeSiteFiles, startSiteSnapshotPreview, stopSiteSnapshotPreview } from './site-deployment-snapshot'
import { localSiteOwner, localSiteTaskKey } from './local-site-catalog'

interface Host {
  root(): string
  session(id: string): SessionMeta | undefined
  authorize(id: string): Promise<void>
  assertRead(id: string, path: string): void | Promise<void>
}
interface Entry { owner: number; sessionId: string; identity: string; directory: string; view: LocalSitePreview; timer: ReturnType<typeof setTimeout> }
const identity = (meta: SessionMeta): string => JSON.stringify([meta.id, meta.createdAt, meta.cwd, meta.workspaceId, meta.goalId, meta.workItemId])

/** Ephemeral local read-only snapshots; no hosting target or process execution. */
export class LocalSitePreviewService {
  private readonly entries = new Map<string, Entry>()
  private readonly generations = new Map<string, number>()
  constructor(private readonly host: Host) {}
  private key(owner: number, sessionId: string): string { return `${owner}:${sessionId}` }
  private session(id: string): SessionMeta {
    const meta = this.host.session(id)
    if (!meta || meta.status === 'closed' || meta.sideChat) throw new Error('当前任务不可用或属于只读侧聊。')
    return meta
  }
  async start(owner: number, sessionId: string, input: string, expectedTaskKey?: string): Promise<LocalSitePreview> {
    if (typeof input !== 'string' || !input.trim() || input.length > 4096 || /[\x00-\x1f]/.test(input)) throw new Error('请输入当前任务目录内的 HTML 文件或构建目录。')
    const key = this.key(owner, sessionId), revision = (this.generations.get(key) ?? 0) + 1
    this.generations.set(key, revision)
    const meta = this.session(sessionId), binding = identity(meta)
    const assertCurrent = (): void => {
      if (this.generations.get(key) !== revision || identity(this.session(sessionId)) !== binding) throw new Error('预览已取消或任务目录/身份已变化。')
    }
    if (expectedTaskKey && localSiteTaskKey(localSiteOwner(meta, await realpath(meta.cwd))) !== expectedTaskKey) throw new Error('原站点任务归属已变化，请刷新站点列表。')
    assertCurrent()
    await this.host.authorize(sessionId); assertCurrent()
    const source = await resolveExistingProjectPath(meta.cwd, input.trim())
    const info = await lstat(source.fullPath)
    if (!info.isDirectory() && (!info.isFile() || !['.html', '.htm'].includes(extname(source.fullPath).toLowerCase()))) throw new Error('请选择 HTML 文件或已构建的静态目录；开发服务器请在终端启动。')
    const single = info.isFile(), sourceDirectory = single ? dirname(source.fullPath) : source.fullPath
    const entryPath = single ? basename(source.fullPath) : 'index.html'
    const id = randomUUID(), directory = join(this.host.root(), 'local-site-previews', id)
    try {
      const frozen = await freezeSiteFiles(meta.cwd, relative(source.root, sourceDirectory) || '.', directory, {
        ...(single ? { onlyFile: entryPath } : {}),
        assertRead: async path => {
          assertCurrent()
          await resolveExistingProjectPath(meta.cwd, path)
          await this.host.assertRead(sessionId, path)
        }
      })
      if (!frozen.files.some(file => file.path === entryPath)) throw new Error('构建目录缺少 index.html；也可以直接选择具体 HTML 文件。')
      assertCurrent(); await this.host.authorize(sessionId); assertCurrent()
      const createdAt = Date.now(), expiresAt = createdAt + 30 * 60_000
      const url = new URL(await startSiteSnapshotPreview(id, directory, expiresAt))
      url.pathname = `/${entryPath.split('/').map(encodeURIComponent).join('/')}`
      assertCurrent()
      const view: LocalSitePreview = { id, sessionId, sourcePath: source.relativePath || '.', kind: single ? 'html' : 'directory', entryPath,
        localUrl: url.toString(), fileCount: frozen.files.length, bytes: frozen.bytes, manifestDigest: frozen.manifestDigest, createdAt, expiresAt }
      const previous = this.entries.get(key)
      const timer = setTimeout(() => { void this.stop(owner, sessionId, id).catch(() => undefined) }, expiresAt - Date.now()); timer.unref()
      this.entries.set(key, { owner, sessionId, identity: binding, directory, view, timer })
      if (previous) await this.disposeEntry(previous)
      return view
    } catch (error) { stopSiteSnapshotPreview(id); await rm(directory, { recursive: true, force: true }); throw error }
  }
  async get(owner: number, sessionId: string): Promise<LocalSitePreview | null> {
    const entry = this.entries.get(this.key(owner, sessionId))
    if (!entry) return null
    const meta = this.host.session(sessionId)
    if (!meta || meta.status === 'closed' || identity(meta) !== entry.identity || entry.view.expiresAt <= Date.now()) {
      await this.stop(owner, sessionId); return null
    }
    return entry.view
  }
  async stop(owner: number, sessionId: string, id?: string): Promise<void> {
    const key = this.key(owner, sessionId), entry = this.entries.get(key)
    if (id && entry?.view.id !== id) return
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
    this.entries.delete(key)
    if (entry) await this.disposeEntry(entry)
  }
  async stopOwner(owner: number): Promise<void> {
    const prefix = `${owner}:`
    await Promise.all([...this.generations.keys()].filter(key => key.startsWith(prefix)).map(key => this.stop(owner, key.slice(prefix.length))))
  }
  async stopSession(sessionId: string): Promise<void> {
    const suffix = `:${sessionId}`
    await Promise.all([...this.generations.keys()].filter(key => key.endsWith(suffix)).map(key => this.stop(Number(key.slice(0, -suffix.length)), sessionId)))
  }
  async refreshSession(sessionId: string): Promise<void> {
    const meta = this.host.session(sessionId)
    if (!meta || meta.status === 'closed') { await this.stopSession(sessionId); return }
    for (const entry of this.entries.values()) if (entry.sessionId === sessionId && entry.identity !== identity(meta)) await this.stop(entry.owner, sessionId)
  }
  async dispose(): Promise<void> {
    await Promise.all([...new Set([...this.generations.keys()].map(key => Number(key.split(':', 1)[0])))].map(owner => this.stopOwner(owner)))
  }
  private async disposeEntry(entry: Entry): Promise<void> {
    clearTimeout(entry.timer); stopSiteSnapshotPreview(entry.view.id)
    await rm(entry.directory, { recursive: true, force: true })
  }
}
