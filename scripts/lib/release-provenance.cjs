const { execFileSync } = require('node:child_process')
const path = require('node:path')

const RELEASE_PROVENANCE_SCHEMA_VERSION = 1

function createReleaseProvenance(repoRoot, packageVersion) {
  const commit = gitOutput(repoRoot, ['rev-parse', 'HEAD'])
  const status = gitOutput(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
  return {
    schemaVersion: RELEASE_PROVENANCE_SCHEMA_VERSION,
    gitCommit: /^[0-9a-f]{40}$/i.test(commit) ? commit : null,
    worktreeClean: status !== null && status.length === 0,
    packageVersion
  }
}

function readPackagedReleaseProvenance(appPath) {
  const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar')
  return readPackagedReleaseProvenanceFromAsar(asarPath)
}

function readPackagedReleaseProvenanceFromAsar(asarPath) {
  try {
    const { extractFile } = require('@electron/asar')
    const packageJson = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'))
    const value = packageJson.eastgenesisReleaseProvenance || packageJson.caogenReleaseProvenance || null
    return {
      asarPath,
      present: Boolean(value),
      value,
      error: null
    }
  } catch (error) {
    return {
      asarPath,
      present: false,
      value: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function releaseProvenanceChecks(provenance, expected) {
  return {
    present: Boolean(provenance),
    schemaVersionMatches: provenance?.schemaVersion === RELEASE_PROVENANCE_SCHEMA_VERSION,
    gitCommitMatches: provenance?.gitCommit === expected.gitCommit,
    worktreeWasClean: provenance?.worktreeClean === true,
    packageVersionMatches: provenance?.packageVersion === expected.packageVersion
  }
}

function gitOutput(repoRoot, args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return null
  }
}

module.exports = {
  RELEASE_PROVENANCE_SCHEMA_VERSION,
  createReleaseProvenance,
  readPackagedReleaseProvenance,
  readPackagedReleaseProvenanceFromAsar,
  releaseProvenanceChecks
}
