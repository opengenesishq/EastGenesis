const path = require('node:path')
const { dialog } = require('electron')
const mainEntry = process.env.CAOGEN_OFFICE_UI_MAIN_ENTRY
const exportPath = process.env.CAOGEN_OFFICE_UI_EXPORT_PATH
if (!mainEntry || !path.isAbsolute(mainEntry) || !exportPath || !path.isAbsolute(exportPath)) throw new Error('Office UI fixture requires explicit isolated paths')
const originalSave = dialog.showSaveDialog.bind(dialog)
dialog.showSaveDialog = async (...args) => {
  const options = args.at(-1)
  if (options?.title !== '导出 CaoGen 可移植交付包') return originalSave(...args)
  if (!options.filters?.some((filter) => filter.extensions.includes('zip'))) throw new Error('Unexpected export dialog format')
  process.stdout.write('[office-ui-fixture] user selected isolated ZIP export destination\n')
  return { canceled: false, filePath: exportPath }
}
require(mainEntry)
