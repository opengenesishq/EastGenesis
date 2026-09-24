import { createHash } from 'node:crypto'
import { lstat, open, readdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Purge helpers for media files created by earlier versions; generation was removed in 1.0. */
export async function purgeMediaProjectFiles(rootDir: string, projectId: string): Promise<number> {
  const root = mediaProjectRoot(rootDir, projectId)
  try {
    const state = await lstat(root)
    if (state.isSymbolicLink() || !state.isDirectory()) throw new Error('Managed media Project root is invalid')
    const count = await countManagedMediaFiles(root)
    await rm(root, { recursive: true, force: false })
    await syncDirectory(dirname(root))
    return count
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return 0
  }
}

export async function countMediaProjectFiles(rootDir: string, projectId: string): Promise<number> {
  const root = mediaProjectRoot(rootDir, projectId)
  try {
    const state = await lstat(root)
    if (state.isSymbolicLink() || !state.isDirectory()) throw new Error('Managed media Project root is invalid')
    return countManagedMediaFiles(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

export async function purgeLegacyMediaProviderOutputFiles(rootDir: string, sourceRefs: readonly string[]): Promise<number> {
  const legacyRoot = resolve(rootDir, 'media-provider-outputs')
  let count = 0
  for (const sourceRef of [...new Set(sourceRefs)].sort()) {
    if (!isAbsolute(sourceRef)) continue
    const target = resolve(sourceRef)
    const child = relative(legacyRoot, target)
    if (!/^[a-f0-9]{64}$/.test(child) || isAbsolute(child) || child.includes(sep)) continue
    try {
      const state = await lstat(target)
      if (!state.isFile() || state.isSymbolicLink()) throw new Error('Legacy media Provider output is invalid')
      await rm(target)
      await syncDirectory(legacyRoot)
      count += 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  try {
    if ((await readdir(legacyRoot)).length === 0) {
      await rm(legacyRoot)
      await syncDirectory(dirname(legacyRoot))
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return count
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

export function mediaProjectRoot(rootDir: string, projectId: string): string {
  const identity = createHash('sha256').update(projectId).digest('hex')
  return join(resolve(rootDir), 'media-files', identity)
}

async function countManagedMediaFiles(root: string): Promise<number> {
  let count = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    const state = await lstat(path)
    if (state.isSymbolicLink()) throw new Error('Managed media Project tree contains a symbolic link')
    if (state.isFile()) count += 1
    else if (state.isDirectory()) count += await countManagedMediaFiles(path)
    else throw new Error('Managed media Project tree contains an unsupported entry')
  }
  return count
}
