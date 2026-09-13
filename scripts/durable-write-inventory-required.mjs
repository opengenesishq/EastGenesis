#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DURABLE_WRITE_REGISTRY } from './durable-write-registry.mjs'
import {
  discoverDurableWriteModules,
  validateDurableWriteRegistry
} from './lib/durable-write-inventory.mjs'

const repoRoot = process.cwd()
const discovery = discoverDurableWriteModules(repoRoot)

if (process.argv.includes('--print-discovered')) {
  console.log(JSON.stringify(discovery, null, 2))
  process.exit(0)
}

const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const reportRoot = path.join(repoRoot, 'test-results', 'durable-write-inventory')
const reportDir = path.join(reportRoot, runId)
const report = {
  schemaVersion: 1,
  runId,
  status: 'failed',
  inventoryStatus: 'incomplete',
  requirementStatus: 'open',
  sourceRevision: gitOutput(['rev-parse', 'HEAD']),
  worktreeStatusCount: gitOutput(['status', '--porcelain']).split('\n').filter(Boolean).length,
  checks: [],
  summary: {},
  writers: [],
  failures: []
}

try {
  const failures = validateDurableWriteRegistry(DURABLE_WRITE_REGISTRY, discovery)
  assert(failures.length === 0, failures.join('\n'))
  check('all source-observed filesystem writer modules are registered')
  check('domain, journal, audit, and derived writers declare schema and version status')
  check('every writer declares an atomic, transaction, log, delegated, direct, or exempt strategy')
  check('direct and unversioned domain writes remain explicit gaps')
  check('non-domain exemptions name their boundary and reason')
  runDiscoveryFixtures()
  runNegativeFixtures()

  const summary = summarize(DURABLE_WRITE_REGISTRY, discovery)
  report.status = 'passed'
  report.inventoryStatus = 'complete'
  report.requirementStatus = summary.recovery.gap > 0 ? 'open' : 'inventory_closed_unverified'
  report.summary = summary
  report.writers = discovery.map((item) => ({
    ...item,
    contract: DURABLE_WRITE_REGISTRY.find((entry) => entry.file === item.file)
  }))
} catch (error) {
  report.failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
} finally {
  mkdirSync(reportDir, { recursive: true })
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), serialized, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), serialized, 'utf8')
}

console.log(JSON.stringify({
  status: report.status,
  inventoryStatus: report.inventoryStatus,
  requirementStatus: report.requirementStatus,
  runId,
  checks: report.checks.length,
  summary: report.summary,
  failures: report.failures,
  reportDir
}, null, 2))

function runNegativeFixtures() {
  const first = DURABLE_WRITE_REGISTRY[0]
  assert(first, 'negative fixtures require a registry entry')
  assertFailure(
    DURABLE_WRITE_REGISTRY.filter((entry) => entry.file !== first.file),
    /unregistered filesystem writer/,
    'unregistered writer is rejected'
  )
  assertFailure(
    [...DURABLE_WRITE_REGISTRY, { ...first, file: 'src/main/stale-writer-fixture.ts' }],
    /stale writer registry entry/,
    'stale registry entry is rejected'
  )

  const domainEntry = DURABLE_WRITE_REGISTRY.find((entry) => entry.dataClass === 'domain_state')
  assert(domainEntry, 'negative fixtures require a domain writer')
  assertFailure(
    replaceEntry(domainEntry.file, { schema: '' }),
    /requires a schema declaration/,
    'domain writer without schema is rejected'
  )
  assertFailure(
    replaceEntry(domainEntry.file, { version: 'unversioned', recovery: 'implemented_unverified' }),
    /must remain an explicit recovery gap/,
    'unversioned domain writer cannot be marked implemented'
  )

  const directEntry = DURABLE_WRITE_REGISTRY.find((entry) => entry.strategy === 'direct_write')
  assert(directEntry, 'negative fixtures require a direct writer')
  assertFailure(
    replaceEntry(directEntry.file, {
      recovery: 'implemented_unverified',
      gap: undefined,
      exemption: undefined
    }),
    /direct_write must remain an explicit gap or exemption/,
    'direct writer cannot silently claim durable recovery'
  )

  const delegatedEntry = DURABLE_WRITE_REGISTRY.find((entry) => entry.strategy === 'delegated_atomic')
  assert(delegatedEntry, 'negative fixtures require a delegated writer')
  assertFailure(
    replaceEntry(delegatedEntry.file, { delegate: '' }),
    /requires a concrete delegate/,
    'delegated writer without an owner is rejected'
  )

}

function runDiscoveryFixtures() {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'caogen-durable-writer-discovery-'))
  const sourceRoot = path.join(fixtureRoot, 'src/main')
  mkdirSync(sourceRoot, { recursive: true })
  try {
    const fixtures = {
      'alias.ts': "import { writeFile as save } from 'node:fs/promises'\nvoid save('a', 'x')\n",
      'namespace.ts': "import fs from 'node:fs'\nvoid fs.promises.rename('a', 'b')\n",
      'nested-require.ts': "export function save() { const { appendFileSync: append } = require('node:fs'); append('a', 'x') }\n",
      'require-handle.ts': "export async function save() { const { open: acquire } = require('node:fs/promises'); const handle = await acquire('a', 'w'); await handle.writeFile('x'); await handle.sync() }\n",
      'read-only.ts': "import { readFile } from 'node:fs/promises'\nvoid readFile('a')\n"
    }
    for (const [name, source] of Object.entries(fixtures)) {
      writeFileSync(path.join(sourceRoot, name), source, 'utf8')
    }
    const discovered = discoverDurableWriteModules(fixtureRoot)
    const files = new Set(discovered.map((entry) => path.basename(entry.file)))
    for (const name of ['alias.ts', 'namespace.ts', 'nested-require.ts', 'require-handle.ts']) {
      assert(files.has(name), `discovery fixture was missed: ${name}`)
    }
    assert(!files.has('read-only.ts'), 'read-only filesystem fixture must not be classified as a writer')
    check('filesystem writer discovery covers aliases, namespaces, nested require, and FileHandle writes')
    check('read-only filesystem imports are excluded from the writer inventory')
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

function replaceEntry(file, patch) {
  return DURABLE_WRITE_REGISTRY.map((entry) => entry.file === file ? { ...entry, ...patch } : entry)
}

function assertFailure(registry, expected, label) {
  const failures = validateDurableWriteRegistry(registry, discovery)
  assert(failures.some((failure) => expected.test(failure)), `${label}: ${failures.join('; ')}`)
  check(label, 'negative')
}

function summarize(registry, currentDiscovery) {
  return {
    modules: registry.length,
    sinkCalls: currentDiscovery.reduce((total, item) => total + item.sinks.length, 0),
    dataClasses: countBy(registry, (entry) => entry.dataClass),
    strategies: countBy(registry, (entry) => entry.strategy),
    recovery: countBy(registry, (entry) => entry.recovery),
    versionedSchemaWriters: registry.filter((entry) =>
      entry.schema !== 'not_applicable' && !/(?:unversioned|unknown|mixed)/i.test(entry.version)
    ).length,
    explicitSchemaGaps: registry.filter((entry) =>
      entry.schema !== 'not_applicable' && /(?:unversioned|unknown|mixed)/i.test(entry.version)
    ).length,
    negativePaths: report.checks.filter((item) => item.kind === 'negative').length
  }
}

function countBy(values, keyFor) {
  const counts = {}
  for (const value of values) {
    const key = keyFor(value)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function check(name, kind = 'positive') {
  report.checks.push({ name, kind, status: 'passed' })
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return 'unknown'
  }
}
