#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const repoRoot = process.cwd()
const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'caogen-worker-execution-context-'))
const userData = path.join(fixtureRoot, 'user-data')
const reportPath = path.join(repoRoot, 'test-results', 'digital-worker-execution-context', 'latest.json')
let report = { schemaVersion: 1, kind: 'caogen.digital-worker-execution-context-report', status: 'failed', providerCalls: 0, humanEvidence: false }
try {
  mkdirSync(userData, { recursive: true })
  const electronStub = path.join(fixtureRoot, 'electron-stub.ts')
  const bundle = path.join(fixtureRoot, 'execution-context.cjs')
  writeFileSync(electronStub, `export const app = { getPath: () => ${JSON.stringify(userData)}, getVersion: () => '0.1.9', isPackaged: false };\nexport const safeStorage = { isEncryptionAvailable: () => false };\n`)
  const stubs = new Map([
    ['./settings', 'export const getSettings = () => ({ autoSkillLearningEnabled: false })'],
    ['./skill/skill-invocation', 'export const buildSkillInvocationPrompt = () => ""'],
    ['./memory/memory-retriever', 'export const buildEffectiveMemoryPrompt = async () => globalThis.__workerContextRetrieval ? globalThis.__workerContextRetrieval() : ""'],
    ['./ide/ide-document-context', 'export const buildIdeDocumentContextPrompt = () => ""']
  ])
  await build({ entryPoints: [path.join(repoRoot, 'scripts', 'digital-worker-execution-context-entry.ts')], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external', alias: { electron: electronStub },
    plugins: [{ name: 'isolate-unrelated-layered-retrieval', setup(builder) {
      builder.onResolve({ filter: /^\.\// }, (args) => {
        if (args.importer === path.join(repoRoot, 'src', 'main', 'native-layered-prompt.ts') && stubs.has(args.path)) {
          return { path: args.path, namespace: 'layered-retrieval-fixture' }
        }
      })
      builder.onLoad({ filter: /.*/, namespace: 'layered-retrieval-fixture' }, (args) => ({ contents: stubs.get(args.path), loader: 'ts' }))
    } }] })
  const env = { ...process.env, CAOGEN_USER_DATA_DIR: userData, CAOGEN_MEMORY_DIR: path.join(fixtureRoot, 'memory'), NODE_PATH: path.join(repoRoot, 'node_modules') }
  for (const key of Object.keys(env)) if (/^(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE)_(?:API_KEY|AUTH_TOKEN|BASE_URL)$/.test(key)) delete env[key]
  const output = execFileSync(process.execPath, [bundle, userData], { cwd: repoRoot, encoding: 'utf8', env, timeout: 60_000 })
  const result = JSON.parse(output.trim().split('\n').at(-1))
  report = { ...report, ...result }
  console.log(`DigitalWorker execution context: PASS (${result.checks.length}/${result.checks.length})\nreport: ${reportPath}`)
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
