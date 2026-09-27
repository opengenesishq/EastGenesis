import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

export function candidateIdentityChecks({
  requestedCommit,
  actualCommit,
  requestedVersion,
  packageVersion,
  lockVersion,
  rootLockVersion,
  worktreeClean,
  commitOnMain
}) {
  return {
    requestedCommitIsFullSha: /^[0-9a-f]{40}$/.test(requestedCommit || ''),
    checkedOutCommitMatches: actualCommit === requestedCommit,
    requestedVersionIsStable: /^\d+\.\d+\.\d+$/.test(requestedVersion || ''),
    packageVersionMatches: packageVersion === requestedVersion,
    lockVersionMatches: lockVersion === requestedVersion,
    rootLockVersionMatches: rootLockVersion === requestedVersion,
    worktreeIsClean: worktreeClean === true,
    commitIsOnOriginMain: commitOnMain === true
  }
}

export function deepEvidenceChecks(report, expectedCommit) {
  return {
    deepPassed: report?.status === 'pass' && report?.exitCode === 0,
    deepCommitMatches: report?.git?.commit === expectedCommit,
    deepStartedClean: report?.git?.start?.worktreeClean === true,
    deepEndedClean: report?.git?.end?.worktreeClean === true,
    deepGitUnchanged: report?.git?.unchanged === true,
    deepRequiredAllPassed:
      Number.isInteger(report?.summary?.required?.total) &&
      report.summary.required.total > 0 &&
      report?.summary?.required?.counts?.pass === report.summary.required.total &&
      report?.summary?.required?.blocking === 0
  }
}

export function artifactReportChecks(report, expectedFiles, distDir) {
  const reportedFiles = report?.artifactSet?.files
  const checks = {
    artifactReportComplete: report?.artifactSet?.complete === true,
    artifactReportDigestBound: /^[0-9a-f]{64}$/i.test(report?.artifactSetSha256 || ''),
    artifactReportHasExactFileCount:
      reportedFiles && typeof reportedFiles === 'object' && Object.keys(reportedFiles).length === expectedFiles.length
  }
  for (const file of expectedFiles) {
    const absolutePath = path.join(distDir, file)
    const expected = reportedFiles?.[file] ?? reportedFiles?.[`dist/${file}`]
    checks[`artifact:${file}:present`] = existsSync(absolutePath)
    checks[`artifact:${file}:size`] = Boolean(expected) && existsSync(absolutePath) && expected.size === statSync(absolutePath).size
    checks[`artifact:${file}:sha256`] =
      Boolean(expected) && existsSync(absolutePath) && expected.sha256 === sha256File(absolutePath)
  }
  return checks
}

export function artifactSetEntryForPath(reportedFiles, { repoRoot, distDir, artifactPath }) {
  if (!reportedFiles || typeof reportedFiles !== 'object' || Array.isArray(reportedFiles)) return undefined
  const targetPath = path.resolve(artifactPath)
  for (const [reportedPath, entry] of Object.entries(reportedFiles)) {
    if (
      typeof reportedPath !== 'string' ||
      !reportedPath ||
      path.posix.isAbsolute(reportedPath) ||
      path.win32.isAbsolute(reportedPath) ||
      reportedPath.split(/[\\/]/).includes('..')
    ) continue
    const normalized = path.normalize(reportedPath)
    const baseDir = path.dirname(normalized) === '.' ? distDir : repoRoot
    const resolved = path.resolve(baseDir, normalized)
    const relative = path.relative(baseDir, resolved)
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue
    if (resolved === targetPath) return entry
  }
  return undefined
}

export function renderMacUpdateMetadata({ version, distDir, releaseDate }) {
  const assetNames = [
    `EastGenesis-${version}-mac.zip`,
    `EastGenesis-${version}.dmg`,
    `EastGenesis-${version}-arm64-mac.zip`,
    `EastGenesis-${version}-arm64.dmg`
  ]
  const files = assetNames.map((name) => updateFile(distDir, name))
  const metadata = {
    version,
    files,
    path: files[0].url,
    sha512: files[0].sha512,
    releaseDate
  }
  return yaml.dump(metadata, {
    noRefs: true,
    lineWidth: -1,
    quotingType: "'"
  })
}

export function macUpdateMetadataChecks(text, { version, distDir }) {
  return updateMetadataChecks(text, {
    version,
    distDir,
    expectedNames: [
      `EastGenesis-${version}-mac.zip`,
      `EastGenesis-${version}.dmg`,
      `EastGenesis-${version}-arm64-mac.zip`,
      `EastGenesis-${version}-arm64.dmg`
    ],
    expectedFileCountLabel: 'updateMetadataHasFourFiles'
  })
}

export function macosX64UpdateMetadataChecks(text, { version, distDir }) {
  return updateMetadataChecks(text, {
    version,
    distDir,
    expectedNames: [
      `EastGenesis-${version}-mac.zip`,
      `EastGenesis-${version}.dmg`
    ],
    expectedFileCountLabel: 'updateMetadataHasTwoFiles'
  })
}

function updateMetadataChecks(text, { version, distDir, expectedNames, expectedFileCountLabel }) {
  let metadata
  try {
    metadata = yaml.load(text)
  } catch {
    return { updateMetadataParses: false }
  }
  const files = Array.isArray(metadata?.files) ? metadata.files : []
  const byUrl = Object.fromEntries(files.map((item) => [item?.url, item]))
  const actualNames = files.map((item) => item?.url)
  const checks = {
    updateMetadataParses: metadata && typeof metadata === 'object',
    updateMetadataVersionMatches: metadata?.version === version,
    [expectedFileCountLabel]: files.length === expectedNames.length,
    updateMetadataHasExactFiles:
      actualNames.length === new Set(actualNames).size &&
      JSON.stringify([...actualNames].sort()) === JSON.stringify([...expectedNames].sort()),
    updateMetadataPathUsesX64Zip: metadata?.path === expectedNames[0],
    updateMetadataTopLevelDigestMatchesX64Zip: metadata?.sha512 === byUrl[expectedNames[0]]?.sha512,
    updateMetadataReleaseDateIsValid: Number.isFinite(Date.parse(metadata?.releaseDate || ''))
  }
  for (const name of expectedNames) {
    const absolutePath = path.join(distDir, name)
    checks[`update:${name}:present`] = existsSync(absolutePath)
    checks[`update:${name}:size`] = existsSync(absolutePath) && byUrl[name]?.size === statSync(absolutePath).size
    checks[`update:${name}:sha512`] = existsSync(absolutePath) && byUrl[name]?.sha512 === sha512File(absolutePath)
  }
  return checks
}

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function sha512File(filePath) {
  return createHash('sha512').update(readFileSync(filePath)).digest('base64')
}

function updateFile(distDir, name) {
  const absolutePath = path.join(distDir, name)
  if (!existsSync(absolutePath)) throw new Error(`update metadata asset is missing: ${name}`)
  return {
    url: name,
    sha512: sha512File(absolutePath),
    size: statSync(absolutePath).size
  }
}
