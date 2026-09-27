export const TRUSTED_MAC_DISTRIBUTION_MIN_VERSION = '0.1.7'
export const RELEASE_PLATFORM_MATRIX_MIN_VERSION = '0.1.7'

export function requiresTrustedMacDistribution(releaseVersion) {
  return compareVersions(releaseVersion, TRUSTED_MAC_DISTRIBUTION_MIN_VERSION) >= 0
}

export function requiresReleasePlatformMatrix(releaseVersion) {
  return compareVersions(releaseVersion, RELEASE_PLATFORM_MATRIX_MIN_VERSION) >= 0
}

export function trustedMacDistributionChecks({
  audit,
  releaseVersion,
  gitState,
  artifactSetSha256,
  targetArch = 'x64'
}) {
  const provenance = audit?.buildProvenance?.app
  return {
    macosDistributionAuditPassed: audit?.status === 'passed',
    macosDistributionAuditWasRequired: audit?.required === true,
    macosDistributionModeMatches: audit?.mode === 'post_build',
    macosDistributionPlatformMatches: audit?.platform === 'darwin',
    macosDistributionVersionMatches: audit?.packageVersion === releaseVersion,
    macosDistributionTargetArchMatches: audit?.targetArch === targetArch,
    macosDistributionCommitMatches: audit?.git?.commit === gitState.commit,
    macosDistributionCleanEvidence: audit?.git?.worktreeClean === true && gitState.worktreeClean,
    macosDistributionArtifactSetMatches:
      Boolean(artifactSetSha256) && audit?.artifactSetSha256 === artifactSetSha256,
    macosDistributionBuildCommitMatches: provenance?.gitCommit === gitState.commit,
    macosDistributionBuildWasClean: provenance?.worktreeClean === true,
    macosDistributionBuildVersionMatches: provenance?.packageVersion === releaseVersion
  }
}

export function trustedWindowsDistributionChecks({
  audit,
  releaseVersion,
  gitState,
  targetArch = 'x64'
}) {
  const provenance = audit?.buildProvenance?.app
  return {
    distributionChannelMatches: (audit?.distributionChannel || 'formal') === 'formal',
    distributionAuditPassed: audit?.status === 'passed',
    distributionAuditWasRequired: audit?.required === true,
    distributionModeMatches: audit?.mode === 'post_build',
    distributionPlatformMatches: audit?.platform === 'win32',
    distributionVersionMatches: audit?.packageVersion === releaseVersion,
    distributionTargetArchMatches: audit?.targetArch === targetArch,
    distributionCommitMatches: audit?.git?.commit === gitState.commit,
    distributionCleanEvidence: audit?.git?.worktreeClean === true && gitState.worktreeClean,
    distributionArtifactSetBound: /^[0-9a-f]{64}$/i.test(audit?.artifactSetSha256 || ''),
    distributionBuildCommitMatches: provenance?.gitCommit === gitState.commit,
    distributionBuildWasClean: provenance?.worktreeClean === true,
    distributionBuildVersionMatches: provenance?.packageVersion === releaseVersion,
    unpackedAppAuthenticodeValid: audit?.signing?.app?.status === 'Valid',
    installerAuthenticodeValid: audit?.signing?.installer?.status === 'Valid'
  }
}

export function unsignedWindowsPreviewChecks({
  audit,
  releaseVersion,
  gitState,
  artifactSetSha256,
  targetArch = 'x64'
}) {
  const provenance = audit?.buildProvenance?.app
  return {
    previewDistributionChannelMatches: audit?.distributionChannel === 'unsigned_preview',
    previewDistributionAuditPassed: audit?.status === 'passed',
    previewDistributionAuditWasRequired: audit?.required === true,
    previewDistributionModeMatches: audit?.mode === 'post_build',
    previewDistributionPlatformMatches: audit?.platform === 'win32',
    previewDistributionVersionMatches: audit?.packageVersion === releaseVersion,
    previewDistributionTargetArchMatches: audit?.targetArch === targetArch,
    previewDistributionCommitMatches: audit?.git?.commit === gitState.commit,
    previewDistributionCleanEvidence: audit?.git?.worktreeClean === true && gitState.worktreeClean,
    previewDistributionArtifactSetMatches:
      /^[0-9a-f]{64}$/i.test(artifactSetSha256 || '') && audit?.artifactSetSha256 === artifactSetSha256,
    previewDistributionBuildCommitMatches: provenance?.gitCommit === gitState.commit,
    previewDistributionBuildWasClean: provenance?.worktreeClean === true,
    previewDistributionBuildVersionMatches: provenance?.packageVersion === releaseVersion,
    previewAppIsUnsigned:
      audit?.signing?.app?.status === 'NotSigned' &&
      audit?.signing?.app?.hasCertificate === false &&
      audit?.signing?.app?.timestamped === false,
    previewInstallerIsUnsigned:
      audit?.signing?.installer?.status === 'NotSigned' &&
      audit?.signing?.installer?.hasCertificate === false &&
      audit?.signing?.installer?.timestamped === false,
    previewStableUpdateMetadataAbsent: audit?.artifacts?.updateMetadata === null,
    previewPublicationMetadataDisabled: audit?.config?.publishDisabled === true,
    previewCertificateEnvironmentDisabled: audit?.config?.certificateEnvironmentDisabled === true,
    previewArtifactNameExplicit:
      audit?.config?.artifactName === 'EastGenesis-${version}-windows-x64-unsigned-preview.${ext}'
  }
}

export function trustedPackagedLaunchChecks({
  audit,
  releaseVersion,
  gitState,
  platform,
  targetArch,
  artifactSetSha256,
  distributionChannel = 'formal'
}) {
  const provenance = audit?.buildProvenance
  return {
    launchDistributionChannelMatches: (audit?.distributionChannel || 'formal') === distributionChannel,
    launchPassed: audit?.status === 'passed',
    installPassed: audit?.installation?.status === 'passed',
    launchPlatformMatches: audit?.platform === platform,
    launchTargetArchMatches: audit?.targetArch === targetArch,
    launchVersionMatches: audit?.packageVersion === releaseVersion,
    launchCommitMatches: audit?.git?.commit === gitState.commit,
    launchCleanEvidence: audit?.git?.worktreeClean === true && gitState.worktreeClean,
    launchArtifactSetMatches:
      /^[0-9a-f]{64}$/i.test(artifactSetSha256 || '') && audit?.artifactSetSha256 === artifactSetSha256,
    launchBuildCommitMatches: provenance?.gitCommit === gitState.commit,
    launchBuildWasClean: provenance?.worktreeClean === true,
    launchBuildVersionMatches: provenance?.packageVersion === releaseVersion
  }
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return -1
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0)
    if (difference !== 0) return difference
  }
  return 0
}

function parseVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) return null
  return value.split('.').map(Number)
}
