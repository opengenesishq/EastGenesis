const packageJson = require('./package.json')
const { createReleaseProvenance } = require('./scripts/lib/release-provenance.cjs')

const baseBuild = packageJson.build || {}
const baseMac = { ...(baseBuild.mac || {}) }
const releaseProvenance = createReleaseProvenance(__dirname, packageJson.version)

// A local preview must never silently become a signed or published build just
// because the host happens to have a Developer ID certificate installed.
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) {
  delete process.env[name]
}

module.exports = {
  ...baseBuild,
  publish: null,
  extraMetadata: {
    ...(baseBuild.extraMetadata || {}),
    eastgenesisReleaseProvenance: releaseProvenance,
    caogenReleaseProvenance: releaseProvenance
  },
  mac: {
    ...baseMac,
    target: [
      { target: 'dmg', arch: ['x64'] },
      { target: 'zip', arch: ['x64'] }
    ],
    identity: null,
    forceCodeSigning: false,
    notarize: false,
    artifactName: 'EastGenesis-${version}-mac-x64-unsigned-preview.${ext}'
  }
}
