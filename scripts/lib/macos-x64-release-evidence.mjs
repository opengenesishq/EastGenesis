export function expectedMacosX64ReleaseAssets(version) {
  return [
    `EastGenesis-${version}-mac.zip`,
    `EastGenesis-${version}-mac.zip.blockmap`,
    `EastGenesis-${version}.dmg`,
    `EastGenesis-${version}.dmg.blockmap`,
    'latest-mac.yml'
  ].sort()
}

export function macosX64ReleaseEvidenceChecks({
  macosAudit,
  packagedApp,
  deep,
  p2,
  expectedVersion,
  candidateIsAncestor
}) {
  const candidateCommit = macosAudit?.git?.commit
  const artifactSetSha256 = macosAudit?.artifactSetSha256
  const expectedAssets = expectedMacosX64ReleaseAssets(expectedVersion)
  const reportedFiles = macosAudit?.artifactSet?.files
  const checks = {
    candidateCommitIsFullSha: /^[0-9a-f]{40}$/i.test(candidateCommit || ''),
    candidateCommitIsCurrentOrAncestor: candidateIsAncestor === true,
    macosAuditPassed: macosAudit?.status === 'passed',
    macosAuditWasRequired: macosAudit?.required === true,
    macosAuditModeMatches: macosAudit?.mode === 'post_build',
    macosAuditPlatformMatches: macosAudit?.platform === 'darwin',
    macosAuditArchMatches: macosAudit?.targetArch === 'x64',
    macosAuditVersionMatches: macosAudit?.packageVersion === expectedVersion,
    macosAuditCommitMatches: macosAudit?.git?.commit === candidateCommit,
    macosAuditWasClean: macosAudit?.git?.worktreeClean === true,
    macosAuditAllChecksPassed: allReportedChecksPassed(macosAudit),
    macosAuditCriticalChecksPassed: criticalMacosChecksPassed(macosAudit),
    macosAuditForbiddenRuntimeAbsent: macosAudit?.forbiddenRuntimeAudit?.count === 0,
    macosAuditMainExecutableIsX64:
      JSON.stringify(macosAudit?.artifacts?.app?.architectures) === JSON.stringify(['x86_64']),
    macosAuditDmgPayloadPassed: macosAudit?.archiveAudits?.dmg?.checks?.counts?.failed === 0,
    macosAuditZipPayloadPassed: macosAudit?.archiveAudits?.zip?.checks?.counts?.failed === 0,
    artifactSetComplete: macosAudit?.artifactSet?.complete === true,
    artifactSetDigestBound: /^[0-9a-f]{64}$/i.test(artifactSetSha256 || ''),
    artifactSetHasExactFiles:
      isRecord(reportedFiles) &&
      JSON.stringify(Object.keys(reportedFiles).sort()) === JSON.stringify(expectedAssets),
    artifactEntriesAreBound:
      isRecord(reportedFiles) &&
      expectedAssets.every((name) =>
        Number.isSafeInteger(reportedFiles[name]?.size) &&
        reportedFiles[name].size > 0 &&
        /^[0-9a-f]{64}$/i.test(reportedFiles[name]?.sha256 || '')
      ),
    macosBuildProvenanceMatches: ['app', 'dmg', 'zip'].every((kind) =>
      provenanceMatches(macosAudit?.buildProvenance?.[kind], candidateCommit, expectedVersion)
    ),
    packagedAppPassed: packagedApp?.status === 'passed',
    packagedAppPlatformMatches: packagedApp?.platform === 'darwin',
    packagedAppArchMatches: packagedApp?.targetArch === 'x64',
    packagedAppVersionMatches: packagedApp?.packageVersion === expectedVersion,
    packagedAppCommitMatches: packagedApp?.git?.commit === candidateCommit,
    packagedAppWasClean: packagedApp?.git?.worktreeClean === true,
    packagedAppInstallPassed: packagedApp?.installation?.status === 'passed',
    packagedAppReleaseAuditPassed: packagedApp?.releaseAudit?.status === 'passed',
    packagedAppCleanupPassed: packagedApp?.cleanup?.status === 'passed',
    packagedAppRendererStarted: packagedApp?.target?.type === 'page' && packagedApp?.target?.title === 'EastGenesis',
    packagedAppArtifactSetMatches: packagedApp?.artifactSetSha256 === artifactSetSha256,
    packagedAppProvenanceMatches: provenanceMatches(
      packagedApp?.buildProvenance,
      candidateCommit,
      expectedVersion
    ),
    deepPassed: deep?.status === 'pass' && deep?.exitCode === 0,
    deepCommitMatches: deep?.git?.commit === candidateCommit,
    deepStartedClean: deep?.git?.start?.worktreeClean === true,
    deepEndedClean: deep?.git?.end?.worktreeClean === true,
    deepGitUnchanged: deep?.git?.unchanged === true,
    deepRequiredAllPassed:
      Number.isSafeInteger(deep?.summary?.required?.total) &&
      deep.summary.required.total > 0 &&
      deep?.summary?.required?.counts?.pass === deep.summary.required.total &&
      deep?.summary?.required?.blocking === 0,
    p2Passed: p2?.status === 'passed',
    p2WasRequired: p2?.required === true,
    p2VersionMatches: p2?.packageVersion === expectedVersion,
    p2CommitMatches: p2?.git?.commit === candidateCommit,
    p2StartedClean: p2?.git?.start?.worktreeClean === true,
    p2EndedClean: p2?.git?.end?.worktreeClean === true,
    p2GitUnchanged: p2?.git?.unchanged === true,
    p2HasNoFailures: Array.isArray(p2?.failures) && p2.failures.length === 0
  }
  return {
    candidateCommit,
    artifactSetSha256,
    expectedAssets,
    reportedFiles: isRecord(reportedFiles) ? reportedFiles : {},
    checks
  }
}

function allReportedChecksPassed(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : []
  return checks.length > 0 &&
    checks.every((item) => item?.status === 'passed') &&
    report?.summary?.total === checks.length &&
    report?.summary?.counts?.passed === checks.length &&
    report?.summary?.counts?.failed === 0
}

function criticalMacosChecksPassed(report) {
  const passedNames = new Set((Array.isArray(report?.checks) ? report.checks : [])
    .filter((item) => item?.status === 'passed')
    .map((item) => item?.name))
  return [
    'app uses a Developer ID Application identity',
    'Gatekeeper accepts the app for execution',
    'the app has a valid stapled notarization ticket',
    'DMG detaches cleanly',
    'Claude Agent SDK and CLI are absent from packaged Mach-O files',
    'macOS x64 update metadata matches the signed assets'
  ].every((name) => passedNames.has(name))
}

function provenanceMatches(value, candidateCommit, expectedVersion) {
  return value?.schemaVersion === 1 &&
    value?.gitCommit === candidateCommit &&
    value?.worktreeClean === true &&
    value?.packageVersion === expectedVersion
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
