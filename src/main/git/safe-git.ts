import { delimiter } from 'node:path'
import { buildMinimalSubprocessEnv } from '../security/subprocess-environment'

const SAFE_LOCAL_GIT_CONFIG = ['-c', 'core.fsmonitor=false'] as const

const SAFE_REMOTE_GIT_CONFIG = [
  ...SAFE_LOCAL_GIT_CONFIG,
  '-c',
  'credential.helper=',
  '-c',
  'credential.interactive=never',
  '-c',
  'core.askPass=',
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.file.allow=always',
  '-c',
  'protocol.http.allow=always',
  '-c',
  'protocol.https.allow=always',
  '-c',
  'protocol.ssh.allow=always',
  '-c',
  'protocol.git.allow=always'
] as const

const LOCAL_COMMAND_ENV_KEYS = new Set([
  'GIT_ASKPASS',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_ATTR_SOURCE',
  'GIT_ATTR_NOSYSTEM',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_SYSTEM',
  'GIT_DIR',
  'GIT_EDITOR',
  'GIT_EXEC_PATH',
  'GIT_EXTERNAL_DIFF',
  'GIT_INDEX_FILE',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_LITERAL_PATHSPECS',
  'GIT_GLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PAGER',
  'GIT_PREFIX',
  'GIT_PROXY_COMMAND',
  'GIT_QUARANTINE_PATH',
  'GIT_REPLACE_REF_BASE',
  'GIT_SEQUENCE_EDITOR',
  'GIT_SHALLOW_FILE',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
  'GIT_SUPER_PREFIX',
  'GIT_WORK_TREE',
  'SSH_ASKPASS',
  'SSH_ASKPASS_REQUIRE'
])

// Repository-local fsmonitor commands are executable code. EastGenesis' structured
// Git reads must never run them implicitly, especially for permission-free tools.
export function withSafeLocalGitConfig(args: readonly string[]): string[] {
  return [...SAFE_LOCAL_GIT_CONFIG, ...args]
}

export function withSafeIndexGitConfig(args: readonly string[], hooksPath: string): string[] {
  return [
    ...SAFE_LOCAL_GIT_CONFIG,
    '-c',
    `core.hooksPath=${hooksPath}`,
    '-c',
    'core.preloadIndex=false',
    '-c',
    'core.splitIndex=false',
    '-c',
    'core.untrackedCache=false',
    '-c',
    'gc.auto=0',
    '-c',
    'maintenance.auto=false',
    '-c',
    'maintenance.autoDetach=false',
    '-c',
    'submodule.recurse=false',
    '-c',
    'protocol.allow=never',
    ...args
  ]
}

// Remote reconciliation is a read-only probe, so it must not inherit command
// hooks from repository/global Git config or the parent process environment.
export function withSafeRemoteGitConfig(args: readonly string[]): string[] {
  return [...SAFE_REMOTE_GIT_CONFIG, ...args]
}

export function withSafeMergeGitConfig(args: readonly string[], hooksPath: string): string[] {
  return [
    ...SAFE_LOCAL_GIT_CONFIG,
    '-c',
    `core.hooksPath=${hooksPath}`,
    '-c',
    'commit.gpgSign=false',
    '-c',
    'merge.gpgSign=false',
    '-c',
    'merge.autoStash=false',
    '-c',
    'merge.renormalize=false',
    '-c',
    'merge.verifySignatures=false',
    '-c',
    'merge.default=caogen-text-v1',
    '-c',
    'merge.caogen-text-v1.driver=git merge-file --marker-size=%L %A %O %B',
    '-c',
    'merge.renames=true',
    '-c',
    'merge.directoryRenames=conflict',
    '-c',
    'merge.renameLimit=10000',
    '-c',
    'diff.renames=true',
    '-c',
    'diff.renameLimit=10000',
    '-c',
    'merge.conflictStyle=merge',
    '-c',
    'merge.stat=false',
    '-c',
    'merge.log=false',
    '-c',
    'merge.branchdesc=false',
    '-c',
    'rerere.enabled=false',
    '-c',
    'rerere.autoUpdate=false',
    '-c',
    'gc.auto=0',
    '-c',
    'maintenance.auto=false',
    '-c',
    'maintenance.autoDetach=false',
    '-c',
    'submodule.recurse=false',
    '-c',
    'protocol.allow=never',
    ...args
  ]
}

export function isolatedLocalGitEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = buildMinimalSubprocessEnv({}, { source: baseEnv })
  for (const key of Object.keys(env)) {
    if (
      LOCAL_COMMAND_ENV_KEYS.has(key) ||
      /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key) ||
      /^GIT_TRACE(?:2)?(?:_|$)/.test(key)
    ) {
      delete env[key]
    }
  }
  env.GIT_ATTR_NOSYSTEM = '1'
  env.GIT_CONFIG_COUNT = '0'
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_NO_LAZY_FETCH = '1'
  env.GIT_NO_REPLACE_OBJECTS = '1'
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_PROTOCOL_FROM_USER = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

export function isolatedRemoteGitEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = isolatedLocalGitEnv(baseEnv)
  env.GCM_INTERACTIVE = 'Never'
  return env
}

export function gitAlternateObjectDirectories(paths: readonly string[]): string {
  return paths.map(gitCStyleQuotedPath).join(delimiter)
}

function gitCStyleQuotedPath(value: string): string {
  if (value.includes('\0')) throw new Error('Git object directory path contains NUL')
  let quoted = '"'
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (character === '"') quoted += '\\"'
    else if (character === '\\') quoted += '\\\\'
    else if (codePoint < 0x20 || codePoint === 0x7f) {
      quoted += `\\${codePoint.toString(8).padStart(3, '0')}`
    } else quoted += character
  }
  return `${quoted}"`
}

export function unsafeMergeConfigKeys(output: string): string[] {
  const unsafe = new Set<string>()
  for (const record of output.split('\0')) {
    if (!record) continue
    const separator = record.indexOf('\n')
    const key = (separator >= 0 ? record.slice(0, separator) : record).trim()
    const value = separator >= 0 ? record.slice(separator + 1) : ''
    const normalized = key.toLowerCase()
    if (
      /^merge\..+\.driver$/.test(normalized) ||
      /^filter\..+\.(?:clean|smudge|process)$/.test(normalized) ||
      /^diff\..+\.(?:command|textconv)$/.test(normalized) ||
      (/^branch\..+\.mergeoptions$/.test(normalized) && value.trim().length > 0)
    ) {
      unsafe.add(key)
    }
  }
  return [...unsafe].sort()
}
