import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** Also canonicalize the existing parent when a fresh store is not created yet. */
export function mediaStoreRoot(rootDir: string): string {
  const absolute = resolve(rootDir)
  try {
    return realpathSync(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(absolute) === absolute) throw error
    return join(mediaStoreRoot(dirname(absolute)), basename(absolute))
  }
}
