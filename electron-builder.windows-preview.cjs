const packageJson = require('./package.json')
const { createReleaseProvenance } = require('./scripts/lib/release-provenance.cjs')

const baseBuild = packageJson.build || {}
const baseWin = { ...(baseBuild.win || {}) }
const releaseProvenance = createReleaseProvenance(__dirname, packageJson.version)

// The preview channel must stay unsigned even on a runner with a discoverable certificate.
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) {
  delete process.env[name]
}

module.exports = {
  ...baseBuild,
  // The preview package ships the verified N-API prebuilds from node-pty.
  // Do not require a local Visual Studio toolchain just to recompile them;
  // release builds keep the default native rebuild path.
  npmRebuild: false,
  publish: null,
  extraMetadata: {
    ...(baseBuild.extraMetadata || {}),
    eastgenesisReleaseProvenance: releaseProvenance,
    caogenReleaseProvenance: releaseProvenance
  },
  win: {
    ...baseWin,
    target: ['nsis'],
    forceCodeSigning: false,
    artifactName: 'EastGenesis-${version}-windows-x64-unsigned-preview.${ext}'
  }
}
