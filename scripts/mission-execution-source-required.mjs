#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'

const repoRoot = process.cwd()
const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'caogen-mission-execution-source-'))
const userData = path.join(fixtureRoot, 'user-data')
const reportPath = path.join(repoRoot, 'test-results', 'mission-execution-source', 'latest.json')
let report = { schemaVersion: 1, kind: 'caogen.mission-execution-source-report', status: 'failed', providerCalls: false, humanEvidence: false }
try {
  mkdirSync(userData, { recursive: true })
  const stub = path.join(fixtureRoot, 'electron-stub.ts')
  const bundle = path.join(fixtureRoot, 'mission-execution-source.cjs')
  writeFileSync(stub, `export const app = { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.1.9', isPackaged: false };\nexport const safeStorage = { isEncryptionAvailable: () => false };\nexport const shell = {};\nexport const dialog = {};\nexport const BrowserWindow = { getAllWindows: () => globalThis.__caogenTrustedSender ? [{ webContents: globalThis.__caogenTrustedSender }] : [], fromWebContents: () => ({ isDestroyed: () => false }) };\nexport const ipcMain = { handlers: new Map(), handle(channel, handler) { this.handlers.set(channel, handler) } };\nexport const desktopCapturer = {};\nexport const systemPreferences = {};\nexport const WebContentsView = class {};\nexport const Notification = class {};\nexport const powerSaveBlocker = {};\n`)
  for (const [name, source] of [
    ['tree-sitter', 'class Parser { setLanguage() {} parse() { return { rootNode: { hasError: false, namedChildren: [] } } } }\nmodule.exports = Parser\n'],
    ['tree-sitter-typescript', 'module.exports = { typescript: {}, tsx: {} }\n'],
    ...['tree-sitter-javascript', 'tree-sitter-python', 'tree-sitter-go', 'tree-sitter-rust', 'tree-sitter-java'].map((name) => [name, 'module.exports = {}\n'])
  ]) {
    const moduleDir = path.join(fixtureRoot, 'node_modules', name)
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(path.join(moduleDir, 'index.js'), source)
  }
  buildSync({ entryPoints: [path.join(repoRoot, 'scripts', 'mission-execution-source-entry.ts')], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(bundle).href) }, alias: { electron: stub } })
  const env = { ...process.env, NODE_PATH: [path.join(fixtureRoot, 'node_modules'), path.join(repoRoot, 'node_modules')].join(path.delimiter) }
  delete env.ELECTRON_RENDERER_URL
  for (const key of Object.keys(env)) if (/^(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE)_(?:API_KEY|AUTH_TOKEN|BASE_URL)$/.test(key)) delete env[key]
  const output = execFileSync(process.execPath, [bundle, userData], { cwd: repoRoot, encoding: 'utf8', env })
  const result = JSON.parse(output.trim().split('\n').at(-1))
  report = { ...report, ...result, limitations: result.limitations ?? ['local main-process fixture with Electron shell and source parser stubs', 'does not prove Provider execution or human acceptance'] }
  console.log(`Mission execution source: PASS (${result.checks.length}/${result.checks.length})\nreport: ${reportPath}`)
} catch (error) {
  report.failure = String(error?.stderr?.toString?.() || error?.message || error)
  console.error(report.failure)
  process.exitCode = 1
} finally {
  report.generatedAt = new Date().toISOString()
  mkdirSync(path.dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  rmSync(fixtureRoot, { recursive: true, force: true })
}
