import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export function caogenExtensionHome(home = homedir()): string {
  if (!process.env.CAOGEN_TEMPORARY_PROFILE_ID) return home
  const profileRoot = process.env.CAOGEN_USER_DATA_DIR
  if (!profileRoot || !isAbsolute(profileRoot)) throw new Error('临时工作空间缺少独立扩展目录。')
  return resolve(profileRoot)
}

// Temporary tasks may discover only extensions stored in their own profile.
// Resolve existing ancestors too, so a linked directory cannot reintroduce the main profile.
export function isAllowedCaogenExtensionRoot(root: string): boolean {
  if (!process.env.CAOGEN_TEMPORARY_PROFILE_ID) return true
  try {
    const profileRoot = realpathSync(caogenExtensionHome())
    let existing = resolve(root)
    const missing: string[] = []
    while (!existsSync(existing)) {
      const parent = dirname(existing)
      if (parent === existing) return false
      missing.unshift(basename(existing))
      existing = parent
    }
    const candidate = resolve(realpathSync(existing), ...missing)
    const rel = relative(profileRoot, candidate)
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  } catch {
    return false
  }
}

export function caogenUserExtensionRoot(home = homedir()): string {
  return resolve(join(caogenExtensionHome(home), '.caogen'))
}

export function caogenProjectExtensionRoot(projectRoot: string): string {
  return resolve(join(resolve(projectRoot), '.caogen'))
}

export function caogenExtensionRegistryRoots(
  projectRoots: Array<string | undefined>,
  home = homedir()
): string[] {
  const roots = projectRoots
    .filter((root): root is string => typeof root === 'string' && root.trim().length > 0)
    .map(caogenProjectExtensionRoot)
    .filter(isAllowedCaogenExtensionRoot)
  roots.push(caogenUserExtensionRoot(home))
  return [...new Set(roots)]
}

export function caogenManagedPluginsRoot(home = homedir()): string {
  return join(caogenUserExtensionRoot(home), 'plugins')
}

export function isCaogenExtensionRegistryRoot(root: string, home = homedir()): boolean {
  const resolved = resolve(root)
  return isAllowedCaogenExtensionRoot(resolved) && (resolved === caogenUserExtensionRoot(home) || basename(resolved) === '.caogen')
}
