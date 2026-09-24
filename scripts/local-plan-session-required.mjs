#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'

const repoRoot = process.cwd()
const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'caogen-local-plan-session-'))
const userData = path.join(fixtureRoot, 'user-data')
const reportPath = path.join(repoRoot, 'test-results', 'local-plan-session', 'latest.json')
let report = { schemaVersion: 1, kind: 'caogen.local-plan-session-report', status: 'failed', providerCalls: false, humanEvidence: false }
try {
  mkdirSync(userData, { recursive: true })
  const stub = path.join(fixtureRoot, 'electron-stub.ts')
  const bundle = path.join(fixtureRoot, 'local-plan-session.cjs')
  writeFileSync(stub, `export const app = { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.1.9', isPackaged: false };\nexport const safeStorage = { isEncryptionAvailable: () => false };\nexport const shell = {};\nexport const dialog = {};\nexport const BrowserWindow = class {};\nexport const ipcMain = {};\nexport const desktopCapturer = {};\nexport const systemPreferences = {};\nexport const WebContentsView = class {};\nexport const Notification = class {};\nexport const powerSaveBlocker = {};\n`)
  for (const [name, source] of [
    ['tree-sitter', 'class Parser { setLanguage() {} parse() { return { rootNode: { hasError: false, namedChildren: [] } } } }\nmodule.exports = Parser\n'],
    ['tree-sitter-typescript', 'module.exports = { typescript: {}, tsx: {} }\n'],
    ...['tree-sitter-javascript', 'tree-sitter-python', 'tree-sitter-go', 'tree-sitter-rust', 'tree-sitter-java'].map((name) => [name, 'module.exports = {}\n'])
  ]) {
    const moduleDir = path.join(fixtureRoot, 'node_modules', name)
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(path.join(moduleDir, 'index.js'), source)
  }
  buildSync({ entryPoints: [path.join(repoRoot, 'scripts', 'local-plan-session-entry.ts')], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(bundle).href) }, alias: { electron: stub } })
  const env = { ...process.env, NODE_PATH: [path.join(fixtureRoot, 'node_modules'), path.join(repoRoot, 'node_modules')].join(path.delimiter) }
  for (const key of Object.keys(env)) if (/^(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE)_(?:API_KEY|AUTH_TOKEN|BASE_URL)$/.test(key)) delete env[key]
  const output = execFileSync(process.execPath, [bundle, userData, '--prepare-legacy-cold-start'], { cwd: repoRoot, encoding: 'utf8', env })
  const result = JSON.parse(output.trim().split('\n').at(-1))
  const coldOutput = execFileSync(process.execPath, [bundle, userData, '--verify-legacy-cold-start'], { cwd: repoRoot, encoding: 'utf8', env })
  const coldResult = JSON.parse(coldOutput.trim().split('\n').at(-1))
  result.checks.push(...coldResult.checks)
  result.fetchCalls += coldResult.fetchCalls
  report = { ...report, ...result, limitations: ['local main-process fixture with Electron shell and source parser stubs', 'does not prove Provider execution or human acceptance'] }
  console.log(`Local plan Session: PASS (${result.checks.length}/${result.checks.length})\nreport: ${reportPath}`)
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
