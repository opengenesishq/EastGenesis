import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fromBuffer, type Entry, type ZipFile } from 'yauzl'
import { catalogDirectory } from './catalog-files'
import { CATALOG_LIMITS } from './catalog-protocol'

export function catalogArchivePath(name: string): string[] {
  if (!name || name.length > 1000 || /[\\:\x00-\x1f\x7f]/.test(name) || name.startsWith('/')) throw new Error('插件压缩包含无效路径。')
  const parts = name.replace(/\/$/, '').split('/')
  if (parts.length > CATALOG_LIMITS.depth || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('插件压缩包含越界或不兼容路径。')
  if (parts.some(part => ['.git', 'node_modules', '.caogen-operations', '.trash'].includes(part.toLowerCase()))) throw new Error('插件压缩包含不支持的控制目录或依赖目录。')
  return parts
}
export async function extractCatalogZip(bytes: Buffer, destination: string, signal: AbortSignal): Promise<void> {
  const root = catalogDirectory(destination)
  const zip = await new Promise<ZipFile>((resolve, reject) => fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: true }, (error, value) => error || !value ? reject(error ?? new Error('ZIP 无效。')) : resolve(value)))
  const names = new Map<string, 'file' | 'directory'>(); let files = 0, total = 0, declared = 0
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown): void => {
      if (settled) return; settled = true; signal.removeEventListener('abort', abort); zip.close()
      if (error) reject(error); else resolve()
    }
    const abort = (): void => finish(new Error('插件下载准备已取消。'))
    signal.addEventListener('abort', abort, { once: true })
    zip.on('error', finish); zip.on('end', () => finish())
    zip.on('entry', (entry: Entry) => {
      void (async () => {
        signal.throwIfAborted()
        files++; if (files > CATALOG_LIMITS.files || entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod)) throw new Error('插件 ZIP 数量、加密或压缩方式不支持。')
        const parts = catalogArchivePath(entry.fileName), directory = entry.fileName.endsWith('/'), key = parts.join('/').normalize('NFC').toLowerCase()
        const unixType = (entry.externalFileAttributes >>> 16) & 0o170000
        if (unixType && unixType !== (directory ? 0o040000 : 0o100000)) throw new Error('插件 ZIP 不允许链接或特殊文件。')
        if (names.has(key)) throw new Error('插件 ZIP 含重复或大小写冲突路径。')
        for (let count = 1; count < parts.length; count++) if (names.get(parts.slice(0, count).join('/').normalize('NFC').toLowerCase()) === 'file') throw new Error('插件 ZIP 文件与目录冲突。')
        if (!directory && [...names.keys()].some(name => name.startsWith(key + '/'))) throw new Error('插件 ZIP 文件与目录冲突。')
        names.set(key, directory ? 'directory' : 'file')
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > CATALOG_LIMITS.expandedBytes - declared) throw new Error('插件 ZIP 展开大小超过上限。')
        declared += entry.uncompressedSize
        if (directory) { if (entry.uncompressedSize) throw new Error('ZIP 目录包含数据。'); catalogDirectory(join(root, ...parts)) }
        else {
          catalogDirectory(join(root, ...parts.slice(0, -1)))
          const input = await new Promise<import('node:stream').Readable>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error || !stream ? reject(error ?? new Error('ZIP 数据缺失。')) : resolve(stream)))
          let entryBytes = 0
          const bound = new Transform({ transform(chunk: Buffer, _encoding, done) {
            entryBytes += chunk.length; total += chunk.length
            done(total > CATALOG_LIMITS.expandedBytes || entryBytes > entry.uncompressedSize ? new Error('插件 ZIP 实际展开数据超限。') : null, chunk)
          } })
          const executable = ((entry.externalFileAttributes >>> 16) & 0o111) !== 0
          await pipeline(input, bound, createWriteStream(join(root, ...parts), { flags: 'wx', mode: executable ? 0o700 : 0o600 }), { signal })
          if (entryBytes !== entry.uncompressedSize) throw new Error('ZIP 文件长度不一致。')
        }
        if (!settled) zip.readEntry()
      })().catch(finish)
    })
    if (signal.aborted) abort(); else zip.readEntry()
  })
  if (!files) throw new Error('插件 ZIP 为空。')
}
