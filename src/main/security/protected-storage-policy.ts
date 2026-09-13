import { spawnSync } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { buildMinimalSubprocessEnv } from './subprocess-environment'

export interface ProtectedStorageRuntimeIdentity {
  platform: NodeJS.Platform
  electronMain: boolean
  isPackaged: boolean
  executablePath: string
}

export interface CodeSignatureProbeResult {
  status: number | null
  output: string
}

export type CodeSignatureProbe = (executablePath: string) => CodeSignatureProbeResult

const TEAM_IDENTIFIER = /^[A-Z0-9]{10}$/

export function isProtectedStorageRuntimeEligible(
  runtime: ProtectedStorageRuntimeIdentity,
  probe: CodeSignatureProbe = probeCodeSignature
): boolean {
  if (runtime.platform !== 'darwin' || !runtime.electronMain) return true
  if (!runtime.isPackaged || !isAbsolute(runtime.executablePath)) return false
  return hasTrustedDeveloperIdSignature(probe(runtime.executablePath))
}

export function hasTrustedDeveloperIdSignature(result: CodeSignatureProbeResult): boolean {
  if (result.status !== 0) return false
  const authority = /^Authority=(Developer ID Application:.+)$/m.exec(result.output)?.[1]?.trim()
  const teamIdentifier = /^TeamIdentifier=(.+)$/m.exec(result.output)?.[1]?.trim()
  const authorityTeam = authority?.match(/\(([A-Z0-9]{10})\)$/)?.[1]
  return Boolean(
    authority
      && teamIdentifier
      && TEAM_IDENTIFIER.test(teamIdentifier)
      && authorityTeam === teamIdentifier
  )
}

function probeCodeSignature(executablePath: string): CodeSignatureProbeResult {
  const result = spawnSync(
    '/usr/bin/codesign',
    ['--display', '--verbose=4', executablePath],
    { encoding: 'utf8', timeout: 2_000, maxBuffer: 64 * 1024, env: buildMinimalSubprocessEnv() }
  )
  return {
    status: result.status,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  }
}
