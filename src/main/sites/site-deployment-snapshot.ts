import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { SiteDeploymentPreview } from '../../shared/site-deployment-types'

const MAX_FILES = 10000, MAX_BYTES = 512 * 1024 * 1024
const BLOCKED = /^(?:\.env(?:\..*)?|\.git|\.svn|\.hg|\.npmrc|\.netrc|\.ssh|id_rsa|id_ed25519)$/i
const servers = new Map<string, { server: Server; timer: ReturnType<typeof setTimeout> }>()
export async function freezeSiteFiles(cwd: string, outputDirectory: string, destination: string, options: {
  onlyFile?: string
  assertRead?(path: string): void | Promise<void>
} = {}): Promise<Pick<SiteDeploymentPreview, 'files' | 'bytes' | 'manifestDigest' | 'sourceDirectory'>> {
  const root = await realpath(cwd), sourceDirectory = await realpath(resolve(root, outputDirectory))
  if (!within(root, sourceDirectory)) throw new Error('发布目录必须位于任务目录内')
  if (within(sourceDirectory, resolve(destination))) throw new Error('预览快照不能写入来源目录内部')
  if (options.onlyFile && (options.onlyFile.includes('/') || options.onlyFile.includes('\\') || options.onlyFile === '..')) throw new Error('预览文件名称无效')
  const files: SiteDeploymentPreview['files'] = []
  let bytes = 0
  await mkdir(destination, { recursive: true, mode: 0o700 })
  try {
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (options.onlyFile && entry.name !== options.onlyFile) continue
        if (BLOCKED.test(entry.name) || /\.(?:pem|key|p12|pfx)$/i.test(entry.name)) throw new Error(`发布目录包含私密或版本控制文件，请使用干净的构建输出目录：${entry.name}`)
        const path = join(directory, entry.name), rel = relative(sourceDirectory, path)
        await options.assertRead?.(path)
        const info = await lstat(path)
        if (info.isSymbolicLink()) throw new Error(`发布目录不接受符号链接：${rel}`)
        if (info.isDirectory()) { await visit(path); continue }
        if (!info.isFile()) throw new Error(`发布目录包含非普通文件：${rel}`)
        if (files.length >= MAX_FILES || info.size + bytes > MAX_BYTES) throw new Error('发布文件超过 10000 个或 512 MB')
        const content = await readFile(path)
        bytes += content.length
        if (bytes > MAX_BYTES) throw new Error('发布文件超过 512 MB')
        const target = join(destination, rel)
        await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 })
        await writeFile(target, content, { mode: 0o600, flag: 'wx' })
        files.push({ path: rel.split(sep).join('/'), bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') })
      }
    }
    await visit(sourceDirectory)
    if (!files.length) throw new Error('发布目录没有文件')
    files.sort((a, b) => a.path.localeCompare(b.path))
    return { files, bytes, manifestDigest: createHash('sha256').update(JSON.stringify(files)).digest('hex'), sourceDirectory }
  } catch (error) { await rm(destination, { force: true, recursive: true }); throw error }
}
export async function verifySiteSnapshot(directory: string, files: SiteDeploymentPreview['files']): Promise<void> {
  const actual: string[] = []
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name), info = await lstat(child)
      if (info.isDirectory()) await visit(child)
      else if (info.isFile()) actual.push(relative(directory, child).split(sep).join('/'))
      else throw new Error('预览文件类型已变化，请重新准备发布')
    }
  }
  await visit(directory)
  if (actual.length !== files.length) throw new Error('预览文件集合已变化，请重新准备发布')
  for (const file of files) {
    const path = resolve(directory, file.path)
    if (!within(directory, path) || !actual.includes(file.path)) throw new Error('预览文件已变化')
    const content = await readFile(path)
    if (content.length !== file.bytes || createHash('sha256').update(content).digest('hex') !== file.sha256) throw new Error('预览文件内容已变化，请重新准备发布')
  }
}
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.wasm': 'application/wasm' }
export async function startSiteSnapshotPreview(id: string, directory: string, expiresAt: number): Promise<string> {
  stopSiteSnapshotPreview(id)
  directory = await realpath(directory)
  const token = randomUUID()
  const server = createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method ?? '')) { res.writeHead(405).end(); return }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const requested = decodeURIComponent(url.pathname)
      const authorized = url.searchParams.get('preview') === token || (req.headers.cookie ?? '').split(';').some(value => value.trim() === `caogen_site_preview=${token}`)
      if (!authorized || requested.includes('\0') || requested.includes('\\')) { res.writeHead(404).end(); return }
      // Cookie authentication keeps root-relative build assets working without
      // exposing the snapshot to requests that do not know the preview token.
      let path = resolve(directory, requested.slice(1) || 'index.html')
      if (!within(directory, path)) { res.writeHead(404).end(); return }
      let info = await lstat(path)
      if (info.isDirectory()) { path = join(path, 'index.html'); info = await lstat(path) }
      if (!info.isFile() || !within(directory, await realpath(path))) { res.writeHead(404).end(); return }
      const content = await readFile(path)
      res.writeHead(200, { 'Content-Type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        ...(url.searchParams.get('preview') === token ? { 'Set-Cookie': `caogen_site_preview=${token}; HttpOnly; SameSite=Strict; Path=/` } : {}) })
      res.end(req.method === 'HEAD' ? undefined : content)
    } catch { res.writeHead(404).end() }
  })
  await new Promise<void>((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise) })
  const address = server.address()
  if (!address || typeof address === 'string') { server.close(); throw new Error('本地预览端口不可用') }
  const timer = setTimeout(() => stopSiteSnapshotPreview(id), Math.max(1, expiresAt - Date.now())); timer.unref(); server.unref()
  servers.set(id, { server, timer })
  return `http://127.0.0.1:${address.port}/?preview=${token}`
}
export function stopSiteSnapshotPreview(id: string): void { const value = servers.get(id); if (value) { clearTimeout(value.timer); value.server.close(); servers.delete(id) } }
export function stopAllSiteSnapshotPreviews(): void { for (const id of servers.keys()) stopSiteSnapshotPreview(id) }
function within(root: string, path: string): boolean { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) }
