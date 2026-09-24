import { lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { writeDurableFileSync } from '../durable-file'

/** App-owned data only. Reject linked ancestors instead of following them. */
export function catalogDirectory(raw: string): string {
  const path = resolve(raw), parent = dirname(path)
  if (parent !== path) catalogDirectory(parent)
  try { const info = lstatSync(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('插件目录准备区含链接或非目录。') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; mkdirSync(path, { mode: 0o700 }) }
  return realpathSync(path)
}
export function catalogRead<T>(path: string, max = 4 * 1024 * 1024): T | undefined {
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw new Error('插件目录记录无法安全读取。')
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
export function catalogWrite(path: string, value: unknown): void {
  catalogDirectory(dirname(path)); writeDurableFileSync(path, JSON.stringify(value), { mode: 0o600 })
}
export function catalogRows(path: string): string[] { catalogDirectory(path); return readdirSync(path).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).sort() }
export function discardCatalogPayload(root: string, path: string): void {
  const canonical = catalogDirectory(root), candidate = resolve(path)
  if (!candidate.startsWith(canonical + sep) || dirname(candidate) !== canonical) throw new Error('准备区清理路径不属于原记录。')
  rmSync(candidate, { recursive: true, force: true })
}
