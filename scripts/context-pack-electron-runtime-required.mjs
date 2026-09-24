import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-context-pack-electron-'))
const userData = path.join(tempRoot, 'user-data')
const bundle = path.join(tempRoot, 'context-pack-runtime.cjs')
const stubModules = path.join(tempRoot, 'node_modules')
const reportDir = path.join(repoRoot, 'test-results', 'context-pack-electron-runtime')
const reportPath = path.join(reportDir, 'latest.json')
const electron = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const runner = path.join(repoRoot, 'scripts', 'context-pack-electron-runtime-runner.cjs')

try {
  mkdirSync(userData, { recursive: true })
  // OpenAIEngine imports the indexer tool graph. This fixture never parses
  // source files, so provide a local parser stub instead of loading native
  // tree-sitter bindings inside the temporary Electron bundle.
  mkdirSync(stubModules, { recursive: true })
  const writeStub = (name, source) => {
    const dir = path.join(stubModules, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'index.js'), source)
  }
  writeStub('tree-sitter', `class Parser { setLanguage() {} parse() { return { rootNode: { hasError: false, namedChildren: [] } } } }\nmodule.exports = Parser\n`)
  writeStub('tree-sitter-typescript', 'module.exports = { typescript: {}, tsx: {} }\n')
  for (const name of ['tree-sitter-javascript', 'tree-sitter-python', 'tree-sitter-go', 'tree-sitter-rust', 'tree-sitter-java']) {
    writeStub(name, 'module.exports = {}\n')
  }
  buildSync({
    entryPoints: [path.join(repoRoot, 'scripts', 'context-pack-electron-runtime-entry.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // The Electron runner loads the bundle as CommonJS. Preserve a concrete
    // filename for main-process modules that call createRequire(import.meta.url)
    // instead of letting esbuild emit an undefined import.meta value.
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(bundle).href) },
    // Keep native parser bindings out of the fixture bundle. The Electron
    // runner supplies a no-op parser stub because this proof exercises only
    // the engine's durable compression seam, never source indexing.
    external: ['electron', 'tree-sitter', 'tree-sitter-typescript', 'tree-sitter-javascript', 'tree-sitter-python', 'tree-sitter-go', 'tree-sitter-rust', 'tree-sitter-java']
  })
  const run = (stage) => execFileSync(electron, ['electron', runner, bundle, stage, userData], {
    cwd: repoRoot,
    env: { ...process.env, ELECTRON_IS_DEV: '0' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const writeOutput = run('write')
  const readOutput = run('read')
  const report = {
    schemaVersion: 1,
    kind: 'caogen.context-pack-electron-runtime-report',
    status: 'passed',
    evidenceStrength: 'electron-main-process-restart-observed',
    providerMode: 'local-mock-summarizer',
    checks: ['electron_process_compression', 'durable_context_pack', 'independent_electron_restart_readback'],
    writeOutput: JSON.parse(writeOutput.trim().split('\n').at(-1)),
    readOutput: JSON.parse(readOutput.trim().split('\n').at(-1)),
    bundleDigest: `sha256:${createHash('sha256').update(readFileSync(bundle)).digest('hex')}`,
    generatedAt: new Date().toISOString()
  }
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log('context pack Electron runtime: PASS (compression, durable write, independent restart readback)')
  console.log(`report: ${reportPath}`)
} catch (error) {
  console.error(error?.stderr?.toString?.() || error?.stack || error)
  process.exitCode = 1
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
