#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cpus, freemem, platform, release, totalmem } from 'node:os'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const startedAt = new Date().toISOString()
const runId = startedAt.replace(/[:.]/gu, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'routing-performance')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-routing-performance-'))
const bundlePath = path.join(tempRoot, 'model-router.cjs')
const require = createRequire(import.meta.url)
const Module = require('node:module')
const originalLoad = Module._load
const candidateCount = 100
const warmupCount = 50
const sampleCount = 1_000
const thresholdMs = 500
const sources = [
  'src/main/model/model-router.ts',
  'src/main/model/model-profile.ts',
  'src/main/modelStats.ts'
]
let report

try {
  bundleProductionRouter()
  installElectronStub()
  const router = require(bundlePath)
  const providers = fixtureProviders()
  assert.equal(providers.flatMap((provider) => provider.models).length, candidateCount)
  const request = routingRequest(providers)
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('routing performance gate forbids Provider network I/O') }
  try {
    for (let index = 0; index < warmupCount; index += 1) router.routeModel(request)
    const samples = Array.from({ length: sampleCount }, () => measure(() => router.routeModel(request)))
    const verification = router.routeModel(request)
    const repeat = router.routeModel(request)
    assert.equal(verification.candidates.length, candidateCount)
    assert.deepEqual(candidateIdentity(verification), candidateIdentity(repeat))
    assert.equal(verification.crossValidationPlan.enabled, true)
    const sorted = [...samples].sort((left, right) => left - right)
    const p95Ms = percentile(sorted, 0.95)
    assert.ok(p95Ms < thresholdMs, `routing P95 ${p95Ms.toFixed(3)}ms must be < ${thresholdMs}ms`)
    report = buildReport('passed', {
      candidateCount,
      warmupCount,
      sampleCount,
      thresholdMs,
      p50Ms: round(percentile(sorted, 0.5)),
      p95Ms: round(p95Ms),
      p99Ms: round(percentile(sorted, 0.99)),
      maxMs: round(sorted.at(-1) ?? 0),
      selected: candidateIdentity(verification),
      crossValidationValidators: verification.crossValidationPlan.validators.length,
      networkIOMode: 'fail-closed'
    })
    console.log(JSON.stringify(report, null, 2))
  } finally {
    globalThis.fetch = originalFetch
  }
} catch (error) {
  report = buildReport('failed', null, serializeError(error))
  console.error(error)
  process.exitCode = 1
} finally {
  try { Module._load = originalLoad } catch {}
  rmSync(tempRoot, { recursive: true, force: true })
  writeReport(report)
}

function bundleProductionRouter() {
  require('esbuild').buildSync({
    entryPoints: [path.join(repoRoot, sources[0])],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: false,
    external: ['electron']
  })
}

function installElectronStub() {
  const userData = path.join(tempRoot, 'electron-user-data')
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => userData } }
    }
    return originalLoad.call(this, request, parent, isMain)
  }
}

function fixtureProviders() {
  const families = [
    'gpt-5', 'gpt-5-mini', 'claude-sonnet', 'claude-haiku', 'gemini-flash',
    'deepseek-chat', 'deepseek-reasoner', 'qwen-long', 'vision-model', 'balanced-model'
  ]
  return Array.from({ length: 10 }, (_, providerIndex) => ({
    id: `provider-${String(providerIndex).padStart(2, '0')}`,
    name: `Provider ${providerIndex}`,
    engine: providerIndex % 2 === 0 ? 'openai' : 'anthropic',
    hasToken: true,
    ready: true,
    models: families.map((family, modelIndex) => `${family}-${providerIndex}-${modelIndex}`),
    // This is a routing throughput gate, so every synthetic candidate must
    // satisfy the request's hard tools/context requirements. Without an
    // explicit capability profile, fallback metadata correctly rejects most
    // candidates and the fixture no longer represents a 100-candidate run.
    advancedConfig: {
      schemaVersion: 1,
      modelProfiles: families.map((family, modelIndex) => ({
        model: `${family}-${providerIndex}-${modelIndex}`,
        capabilities: ['tools', 'coding', 'reasoning', 'summarization', 'longContext'],
        contextWindow: 200_000
      }))
    }
  }))
}

function routingRequest(providers) {
  return {
    providers,
    prompt: 'Review and test a production TypeScript migration with tools',
    requestedTasks: ['coding', 'review', 'testing', 'toolUse'],
    contextTokens: 4_000,
    expectedOutputTokens: 8_000,
    strategy: 'balanced',
    requiresTools: true,
    riskLevel: 'high',
    budget: { remainingUsd: 0.2, hardLimit: true },
    crossValidation: { enabled: true, maxValidators: 2, minRiskLevel: 'high' }
  }
}

function measure(operation) {
  const start = process.hrtime.bigint()
  operation()
  return Number(process.hrtime.bigint() - start) / 1_000_000
}

function percentile(sorted, ratio) {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0
}

function round(value) {
  return Number(value.toFixed(3))
}

function candidateIdentity(decision) {
  return {
    providerId: decision.selected.profile.providerId,
    model: decision.selected.profile.model,
    score: decision.selected.score
  }
}

function buildReport(status, metrics, error = null) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const gitStatus = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim()
  const cpu = cpus()[0]
  return {
    schemaVersion: 1,
    status,
    gate: 'test:routing-performance:required',
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    git: { commit, worktreeClean: gitStatus.length === 0 },
    environment: {
      platform: platform(),
      release: release(),
      arch: process.arch,
      node: process.version,
      cpuModel: cpu?.model ?? 'unknown',
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytes: freemem()
    },
    sourceDigests: Object.fromEntries(sources.map((file) => [file, digest(file)])),
    metrics,
    error
  }
}

function digest(relativePath) {
  return createHash('sha256').update(readFileSync(path.join(repoRoot, relativePath))).digest('hex')
}

function writeReport(value) {
  mkdirSync(path.join(reportRoot, runId), { recursive: true })
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(path.join(reportRoot, runId, 'report.json'), serialized, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), serialized, 'utf8')
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error)
  }
}
