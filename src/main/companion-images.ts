import { createHash } from 'node:crypto'
import { constants, lstatSync, mkdirSync, openSync, readFileSync, fstatSync, closeSync, readdirSync, unlinkSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { CompanionImageAsset } from '../shared/companion-appearance-types'
import { writeDurableFileSync } from './durable-file'

const maxBytes = 8 * 1024 * 1024
function identify(bytes: Buffer): Pick<CompanionImageAsset, 'mime' | 'width' | 'height'> {
  let mime: CompanionImageAsset['mime'], width: number, height: number
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii',12,16) === 'IHDR') {
    mime = 'image/png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20)
  } else if (bytes.length >= 14 && ['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6))) {
    mime = 'image/gif'; width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8)
  } else throw new Error('请选择 PNG 或 GIF 图片。')
  if (!width || !height || width > 4096 || height > 4096 || width * height > 8_000_000) throw new Error('图片尺寸需在 4096 × 4096 以内，且总像素不超过 800 万。')
  return { mime, width, height }
}
function readImage(file: string): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) throw new Error('图片须为本机普通文件，大小不超过 8 MB。')
    const bytes = readFileSync(fd)
    if (bytes.length !== stat.size || bytes.length > maxBytes) throw new Error('图片在读取期间发生变化，请重新选择。')
    return bytes
  } finally { closeSync(fd) }
}
export class CompanionImageStore {
  constructor(private readonly root: string) {}
  private directory(): string {
    const dir = join(this.root, 'companion-images')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('随侍图片目录不可用。')
    return dir
  }
  private id(value: string): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('随侍图片标识无效。'); return value }
  list(): CompanionImageAsset[] {
    return readdirSync(this.directory()).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => this.describe(name.slice(0,-5))).sort((a,b)=>b.createdAt-a.createdAt)
  }
  private describe(id: string): CompanionImageAsset {
    const file = join(this.directory(), `${this.id(id)}.json`), stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('随侍图片记录不可用。')
    const data = JSON.parse(readFileSync(file,'utf8')) as CompanionImageAsset
    if (data.id !== id || !['image/png','image/gif'].includes(data.mime) || typeof data.name !== 'string' || data.name.length > 120 || !Number.isFinite(data.createdAt)) throw new Error('随侍图片记录格式无效。')
    return data
  }
  async import(file: string, validate: (bytes: Buffer) => boolean | Promise<boolean>): Promise<CompanionImageAsset> {
    const bytes = readImage(file), dimensions = identify(bytes)
    if (!await validate(bytes)) throw new Error('图片无法解码，请重新导出 PNG 或 GIF 后再导入。')
    const id = createHash('sha256').update(bytes).digest('hex'), dir = this.directory()
    const existing = this.list().find(item => item.id === id)
    if (existing) { this.preview(id); return existing }
    if (this.list().length >= 30) throw new Error('最多保存 30 个随侍形象，请先移除不用的图片。')
    const asset: CompanionImageAsset = { id, name: basename(file).replace(/[\x00-\x1f\x7f]/g,'').slice(0,120) || '随侍图片', ...dimensions, bytes: bytes.length, createdAt: Date.now() }
    writeDurableFileSync(join(dir, `${id}.image`), bytes)
    writeDurableFileSync(join(dir, `${id}.json`), JSON.stringify(asset))
    return asset
  }
  preview(id: string): { asset: CompanionImageAsset; dataUrl: string } {
    const asset = this.describe(this.id(id)), bytes = readImage(join(this.directory(), `${id}.image`)), dimensions = identify(bytes)
    if (createHash('sha256').update(bytes).digest('hex') !== id || bytes.length !== asset.bytes || dimensions.mime !== asset.mime || dimensions.width !== asset.width || dimensions.height !== asset.height) throw new Error('随侍图片内容已变化，请重新导入。')
    return { asset, dataUrl: `data:${asset.mime};base64,${bytes.toString('base64')}` }
  }
  remove(id: string): void {
    this.describe(this.id(id)); const dir = this.directory()
    // Only app-owned, content-addressed copies; the chosen source file is never removed.
    for (const suffix of ['.json','.image']) { try { unlinkSync(join(dir, `${id}${suffix}`)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
  }
}
