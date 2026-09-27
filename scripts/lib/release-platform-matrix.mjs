import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  requiresReleasePlatformMatrix,
  trustedMacDistributionChecks,
  trustedPackagedLaunchChecks,
  trustedWindowsDistributionChecks,
  unsignedWindowsPreviewChecks
} from './release-packaging-policy.mjs'

export function releasePlatformMatrixChecks({
  releaseVersion,
  gitState,
  macosX64ArtifactSetSha256,
  macosX64Audit,
  macosArm64Audit,
  windowsX64Audit,
  macosX64LaunchAudit,
  macosArm64LaunchAudit,
  windowsX64LaunchAudit
}) {
  if (!requiresReleasePlatformMatrix(releaseVersion)) return {}
  return {
    ...prefixChecks('macosX64', trustedPackagedLaunchChecks({
      audit: macosX64LaunchAudit,
      releaseVersion,
      gitState,
      platform: 'darwin',
      targetArch: 'x64',
      artifactSetSha256: macosX64Audit?.artifactSetSha256
    })),
    ...prefixChecks('macosArm64', trustedMacDistributionChecks({
      audit: macosArm64Audit,
      releaseVersion,
      gitState,
      artifactSetSha256: macosArm64Audit?.artifactSetSha256,
      targetArch: 'arm64'
    })),
    ...prefixChecks('macosArm64', trustedPackagedLaunchChecks({
      audit: macosArm64LaunchAudit,
      releaseVersion,
      gitState,
      platform: 'darwin',
      targetArch: 'arm64',
      artifactSetSha256: macosArm64Audit?.artifactSetSha256
    })),
    ...prefixChecks('windowsX64', trustedWindowsDistributionChecks({
      audit: windowsX64Audit,
      releaseVersion,
      gitState,
      targetArch: 'x64'
    })),
    ...prefixChecks('windowsX64', trustedPackagedLaunchChecks({
      audit: windowsX64LaunchAudit,
      releaseVersion,
      gitState,
      platform: 'win32',
      targetArch: 'x64',
      artifactSetSha256: windowsX64Audit?.artifactSetSha256
    })),
    macosX64ArtifactSetBound: /^[0-9a-f]{64}$/i.test(macosX64ArtifactSetSha256 || '')
  }
}

export function releaseArtifactEvidence(repoRoot, version) {
  const files = requiresReleasePlatformMatrix(version)
    ? [
        ...releasePlatformArtifactNames(version, 'macos-x64'),
        ...releasePlatformArtifactNames(version, 'macos-arm64'),
        ...releasePlatformArtifactNames(version, 'windows-x64'),
        'latest-mac.yml'
      ].sort()
    : [...releasePlatformArtifactNames(version, 'macos-x64'), 'latest-mac.yml'].sort()
  return digestReleaseFiles(repoRoot, files)
}

export function platformScopedReleaseChecks({
  releaseVersion,
  gitState,
  macosX64ArtifactSetSha256,
  macosArm64ArtifactSetSha256,
  windowsPreviewArtifactSetSha256,
  macosX64Audit,
  macosArm64Audit,
  windowsPreviewAudit,
  macosX64LaunchAudit,
  macosArm64LaunchAudit,
  windowsPreviewLaunchAudit
}) {
  return {
    ...prefixChecks('macosX64', trustedMacDistributionChecks({
      audit: macosX64Audit,
      releaseVersion,
      gitState,
      artifactSetSha256: macosX64ArtifactSetSha256,
      targetArch: 'x64'
    })),
    ...prefixChecks('macosX64', trustedPackagedLaunchChecks({
      audit: macosX64LaunchAudit,
      releaseVersion,
      gitState,
      platform: 'darwin',
      targetArch: 'x64',
      artifactSetSha256: macosX64ArtifactSetSha256
    })),
    ...prefixChecks('macosArm64', trustedMacDistributionChecks({
      audit: macosArm64Audit,
      releaseVersion,
      gitState,
      artifactSetSha256: macosArm64ArtifactSetSha256,
      targetArch: 'arm64'
    })),
    ...prefixChecks('macosArm64', trustedPackagedLaunchChecks({
      audit: macosArm64LaunchAudit,
      releaseVersion,
      gitState,
      platform: 'darwin',
      targetArch: 'arm64',
      artifactSetSha256: macosArm64ArtifactSetSha256
    })),
    ...prefixChecks('windowsPreviewX64', unsignedWindowsPreviewChecks({
      audit: windowsPreviewAudit,
      releaseVersion,
      gitState,
      artifactSetSha256: windowsPreviewArtifactSetSha256,
      targetArch: 'x64'
    })),
    ...prefixChecks('windowsPreviewX64', trustedPackagedLaunchChecks({
      audit: windowsPreviewLaunchAudit,
      releaseVersion,
      gitState,
      platform: 'win32',
      targetArch: 'x64',
      artifactSetSha256: windowsPreviewArtifactSetSha256,
      distributionChannel: 'unsigned_preview'
    }))
  }
}

export function platformScopedReleaseArtifactEvidence(repoRoot, version) {
  return digestReleaseFiles(repoRoot, platformScopedReleaseArtifactNames(version).sort())
}

export function platformScopedReleaseArtifactNames(version) {
  return [
    ...releasePlatformArtifactNames(version, 'macos-x64'),
    ...releasePlatformArtifactNames(version, 'macos-arm64'),
    'latest-mac.yml',
    ...releasePlatformArtifactNames(version, 'windows-preview-x64')
  ]
}

export function buildDistributionPolicy({
  repoRoot,
  releaseTargetVersion,
  gitState,
  domains,
  openDomains,
  reports
}) {
  const releaseIdentity = domains.find((domain) => domain.id === 'release_identity')
  const deepTest = domains.find((domain) => domain.id === 'deep_test')
  const productPositioning = domains.find((domain) => domain.id === 'product_positioning')
  const artifacts = platformScopedReleaseArtifactEvidence(repoRoot, releaseTargetVersion)
  const macosX64Artifacts = releasePlatformArtifactEvidence(repoRoot, releaseTargetVersion, 'macos-x64')
  const macosArm64Artifacts = releasePlatformArtifactEvidence(repoRoot, releaseTargetVersion, 'macos-arm64')
  const windowsPreviewArtifacts = releasePlatformArtifactEvidence(repoRoot, releaseTargetVersion, 'windows-preview-x64')
  const distributionChecks = platformScopedReleaseChecks({
    releaseVersion: releaseTargetVersion,
    gitState,
    macosX64ArtifactSetSha256: macosX64Artifacts.artifactSetSha256,
    macosArm64ArtifactSetSha256: macosArm64Artifacts.artifactSetSha256,
    windowsPreviewArtifactSetSha256: windowsPreviewArtifacts.artifactSetSha256,
    macosX64Audit: reports.macosReleaseX64Audit.data,
    macosArm64Audit: reports.macosReleaseArm64Audit.data,
    windowsPreviewAudit: reports.windowsPreviewX64Audit.data,
    macosX64LaunchAudit: reports.packagedAppMacosX64Smoke.data,
    macosArm64LaunchAudit: reports.packagedAppMacosArm64Smoke.data,
    windowsPreviewLaunchAudit: reports.packagedAppWindowsX64PreviewSmoke.data
  })
  const candidateChecks = {
    releaseIdentityReady: releaseIdentity?.status === 'ready',
    deepTestReady: deepTest?.status === 'ready',
    productPositioningReady: productPositioning?.status === 'ready',
    artifactsComplete: artifacts.complete,
    ...distributionChecks
  }
  const candidateFailures = Object.entries(candidateChecks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name)
  const finalNotesReady =
    reports.releaseNotesAudit.data?.status === 'passed' &&
    reports.releaseNotesAudit.data?.mode === 'platform_scoped_final' &&
    reports.releaseNotesAudit.data?.expectedVersion === releaseTargetVersion &&
    reports.releaseNotesAudit.data?.git?.commit === gitState.commit &&
    reports.releaseNotesAudit.data?.git?.worktreeClean === true &&
    reports.releaseNotesAudit.data?.artifactSetSha256 === artifacts.artifactSetSha256
  const githubReleaseReady =
    reports.githubReleaseAudit.data?.status === 'passed' &&
    reports.githubReleaseAudit.data?.required === true &&
    reports.githubReleaseAudit.data?.tagFilter === `v${releaseTargetVersion}` &&
    reports.githubReleaseAudit.data?.platformScoped === true &&
    reports.githubReleaseAudit.data?.releaseCount === 1

  return {
    selectedReleaseChannel: 'macos_formal_windows_unsigned_preview',
    formalCrossPlatform: {
      status: openDomains.length === 0 ? 'ready' : 'blocked',
      doctorStatus: openDomains.length === 0 ? 'ready' : 'not_ready',
      openDomains: openDomains.map((domain) => domain.id),
      windowsRequirement: 'Timestamped Authenticode remains mandatory and unsigned-preview evidence is rejected.'
    },
    platformScopedRelease: {
      description: 'Formal Developer ID/notarized macOS x64 and arm64 plus a clearly labeled Windows x64 unsigned preview.',
      candidateGate: {
        status: candidateFailures.length === 0 ? 'ready' : 'blocked',
        checks: candidateChecks,
        failures: candidateFailures
      },
      finalNotesGate: {
        status: finalNotesReady ? 'ready' : 'blocked',
        command: `npm run test:release-notes-audit:platform-scoped-final -- --version ${releaseTargetVersion}`
      },
      postPublicationGate: {
        status: githubReleaseReady ? 'ready' : 'blocked',
        command: `npm run test:github-release-audit:platform-scoped:required -- --tag v${releaseTargetVersion}`
      },
      artifacts,
      windowsFormalSigningPlan: 'After commercialization, purchase SSL.com IV Code Signing + eSigner, then restore formal Windows Authenticode evidence before closing the formal cross-platform gate.'
    }
  }
}

export function releasePlatformArtifactEvidence(repoRoot, version, target) {
  return digestReleaseFiles(repoRoot, releasePlatformArtifactNames(version, target).sort())
}

export function releasePlatformArtifactNames(version, target) {
  if (target === 'macos-x64') {
    return [
      `EastGenesis-${version}.dmg`,
      `EastGenesis-${version}.dmg.blockmap`,
      `EastGenesis-${version}-mac.zip`,
      `EastGenesis-${version}-mac.zip.blockmap`
    ]
  }
  if (target === 'macos-arm64') {
    return [
      `EastGenesis-${version}-arm64.dmg`,
      `EastGenesis-${version}-arm64.dmg.blockmap`,
      `EastGenesis-${version}-arm64-mac.zip`,
      `EastGenesis-${version}-arm64-mac.zip.blockmap`
    ]
  }
  if (target === 'windows-x64') {
    return [
      `EastGenesis Setup ${version}.exe`,
      `EastGenesis Setup ${version}.exe.blockmap`,
      'latest.yml'
    ]
  }
  if (target === 'windows-preview-x64') {
    return [`EastGenesis-${version}-windows-x64-unsigned-preview.exe`]
  }
  return []
}

export function releasePackagingCommands(trustedDistributionRequired) {
  const platformCommands = trustedDistributionRequired
    ? [
        'npm run release:mac:preflight:x64',
        'npm run dist:mac:release:x64',
        'npm run test:macos-release-audit:required -- --arch x64',
        'npm run test:packaged-app:mac:x64',
        'npm run dist:mac:release:arm64 (on native Apple Silicon)',
        'npm run test:packaged-app:mac:arm64 (on native Apple Silicon)',
        'npm run dist:win:release:x64 (on native Windows x64)',
        'npm run test:packaged-app:win:x64 (on native Windows x64)'
      ]
    : ['npm run dist:mac:x64']
  return [
    'npm run typecheck',
    'npm run build',
    'npm run test:deep',
    'npm run secret:scan:history',
    ...platformCommands,
    'npm run test:release-packaging-audit:required'
  ]
}

export function releasePackagingNextActions(trustedDistributionRequired) {
  return [
    'Bump package.json and package-lock.json only when all required evidence gates are proved.',
    'Run platform packaging and native install/launch audits before uploading.',
    ...(trustedDistributionRequired
      ? ['For v0.1.7 and later, x64-only, unsigned, unnotarized, or non-native preview evidence never satisfies the distribution gate.']
      : []),
    'Run the packaging audit against the intended release version before creating GitHub Release assets.',
    'Publish only the intended installer/update assets; never upload test-results, out, node_modules, .env files, certs, private keys, or local evidence packs.'
  ]
}

function prefixChecks(prefix, checks) {
  return Object.fromEntries(Object.entries(checks).map(([name, passed]) => [
    `${prefix}${name.charAt(0).toUpperCase()}${name.slice(1)}`,
    passed
  ]))
}

function digestReleaseFiles(repoRoot, files) {
  const missing = files.filter((file) => !existsSync(path.join(repoRoot, 'dist', file)))
  if (missing.length > 0) return { complete: false, missing, files: {}, artifactSetSha256: null }
  const digests = Object.fromEntries(files.map((file) => {
    const absolutePath = path.join(repoRoot, 'dist', file)
    return [file, {
      size: statSync(absolutePath).size,
      sha256: createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
    }]
  }))
  return {
    complete: true,
    missing: [],
    files: digests,
    artifactSetSha256: createHash('sha256').update(JSON.stringify(digests)).digest('hex')
  }
}
