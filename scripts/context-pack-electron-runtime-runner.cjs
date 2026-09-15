const path = require('node:path')
const { app } = require('electron')
const [bundle, stage, userData] = process.argv.slice(2)
if (!bundle || !stage || !userData) throw new Error('usage: runner <bundle> <write|read> <userData>')
app.whenReady().then(async () => {
  app.setPath('userData', userData)
  const mod = require(path.resolve(bundle))
  await mod.run(stage, userData)
  app.quit()
}).catch((error) => {
  console.error(error?.stack || error)
  app.exit(1)
})
