const packageJson = require('./package.json')
const { createReleaseProvenance } = require('./scripts/lib/release-provenance.cjs')

const baseBuild = packageJson.build || {}
const baseMac = { ...(baseBuild.mac || {}) }
const baseWin = { ...(baseBuild.win || {}) }
const releaseProvenance = createReleaseProvenance(__dirname, packageJson.version)
delete baseMac.identity

module.exports = {
  ...baseBuild,
  extraMetadata: {
    ...(baseBuild.extraMetadata || {}),
    eastgenesisReleaseProvenance: releaseProvenance,
    // Keep the legacy key in the packaged manifest so existing update and
    // evidence readers can inspect an upgraded build during migration.
    caogenReleaseProvenance: releaseProvenance
  },
  mac: {
    ...baseMac,
    target: ['dmg', 'zip'],
    forceCodeSigning: true,
    hardenedRuntime: true,
    notarize: true,
    sign: 'scripts/macos-sign-with-retry.cjs',
    minimumSystemVersion: '14.0',
    entitlements: 'resources/entitlements.mac.plist',
    entitlementsInherit: 'resources/entitlements.mac.inherit.plist',
    extendInfo: {
      ...(baseMac.extendInfo || {}),
      NSAppleEventsUsageDescription: 'EastGenesis uses automation only for user-approved desktop actions.',
      NSMicrophoneUsageDescription: 'EastGenesis records your voice only when you start voice input, so you can preview and insert a transcription into your task draft.'
    }
  },
  win: {
    ...baseWin,
    target: ['nsis'],
    forceCodeSigning: true
  }
}
