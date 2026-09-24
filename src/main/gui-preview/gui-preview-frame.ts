import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { GuiPreviewCapture } from './gui-preview-events'

export const GUI_PREVIEW_MAX_BYTES = 16 * 1024 * 1024
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
function inside(root: string, path: string): boolean {
  const part = relative(root, path)
  return Boolean(part) && part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part)
}
/** Reads only a hash-bound PNG emitted by the already approved native screenshot tool. */
export async function readGuiPreviewFrame(capture: GuiPreviewCapture): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/.test(capture.sha256)) throw new Error('截图缺少有效内容摘要。')
  const root = resolve(capture.cwd), path = resolve(capture.path)
  if (!inside(root, path)) throw new Error('截图不属于当前任务目录。')
  let cursor = root
  for (const component of relative(root, path).split(/[\\/]/)) {
    cursor = join(cursor, component)
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('截图路径包含符号链接。')
  }
  const canonicalRoot = await realpath(root), canonicalPath = await realpath(path)
  if (!inside(canonicalRoot, canonicalPath)) throw new Error('截图实际路径超出任务目录。')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size < 24 || before.size > GUI_PREVIEW_MAX_BYTES) throw new Error('截图文件为空、过大或类型不受支持。')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await file.stat()
    if (offset !== bytes.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
      !bytes.subarray(0, 8).equals(pngSignature) || createHash('sha256').update(bytes).digest('hex') !== capture.sha256) {
      throw new Error('截图内容已变化，预览已拒绝。')
    }
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
    if (width !== capture.width || height !== capture.height || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 24_000_000) {
      throw new Error('截图尺寸无效或与捕获记录不符。')
    }
    return bytes
  } finally { await file.close() }
}
