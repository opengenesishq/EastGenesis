const path = require('node:path')
const { writeFileSync } = require('node:fs')
const { app } = require('electron')
const [bundle, stage, userData, outputPath, runId] = process.argv.slice(2)
if (!bundle || !stage || !userData || !outputPath || !runId) throw new Error('transaction runner arguments are required')
app.setPath('userData', userData)
app.setPath('sessionData', userData)
app.whenReady().then(async () => {
  // Electron initializes its module paths before this fixture's NODE_PATH is
  // applied on some hosts; refresh them for the external production modules.
  require('node:module').Module._initPaths()
  const result = await require(path.resolve(bundle)).run(stage, userData, runId)
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`)
  app.exit(0)
}).catch((error) => {
  console.error(error?.stack || error)
  app.exit(1)
})
