#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'p2-external-doctor')
const reportDir = path.join(reportRoot, runId)
const required = process.argv.includes('--required')
const refresh = process.argv.includes('--refresh')
const configurationGuide = 'docs/P2-EXTERNAL-REQUIRED.md'

mkdirSync(reportDir, { recursive: true })

const refreshResult = refresh ? runPreflight() : undefined
const preflight = readJson('test-results/p2-external-preflight/latest.json')
const requiredGate = readJson('test-results/p2-required/latest.json')
const audit = readJson('test-results/p2-completion-audit/latest.json')
const report = buildReport(preflight.value, requiredGate.value, audit.value, refreshResult)

writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
writeFileSync(path.join(reportDir, 'report.md'), renderMarkdown(report), 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), JSON.stringify(report, null, 2), 'utf8')
writeFileSync(path.join(reportRoot, 'latest.md'), renderMarkdown(report), 'utf8')

console.log(JSON.stringify(report, null, 2))
if (required && report.status !== 'ready') process.exitCode = 1

function runPreflight() {
  const result = spawnSync(process.execPath, [path.join('scripts', 'p2-external-preflight.mjs'), '--required'], {
    cwd: repoRoot,
    shell: process.platform === 'win32',
    encoding: 'utf8',
    env: process.env,
    timeout: 60_000
  })
  return {
    command: 'node scripts/p2-external-preflight.mjs --required',
    exitCode: result.status,
    timedOut: result.error?.code === 'ETIMEDOUT',
    error: result.error ? String(result.error.message || result.error) : undefined,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr)
  }
}

function buildReport(preflightReport, requiredReport, auditReport, refreshRun) {
  const domains = buildDomains(preflightReport)
  const missingDomains = domains.filter((domain) => domain.status !== 'ready')
  const nextCommands = nextCommandsFor(domains)
  const p2Audit = summarizeAudit(auditReport)
  const p2Required = summarizeRequiredGate(requiredReport)
  return {
    status: missingDomains.length === 0 ? 'ready' : 'missing_external',
    required,
    refreshed: Boolean(refreshRun),
    runId,
    reportDir,
    configurationGuide,
    redactionPolicy: 'Only environment variable names and masked provider IDs are reported; secret values are never written.',
    refreshRun,
    preflightSource: sourceSummary(preflight),
    requiredGateSource: sourceSummary(requiredGate),
    auditSource: sourceSummary(audit),
    domains,
    missingDomains: missingDomains.map((domain) => domain.id),
    p2Required,
    p2Audit,
    nextCommands
  }
}

function buildDomains(preflightReport) {
  const checks = Array.isArray(preflightReport?.checks) ? preflightReport.checks : []
  return [
    jetbrainsDomain(checks.find((check) => check?.name === 'jetbrains_ide_interaction')),
    chinaRealNetworkDomain(checks.find((check) => check?.name === 'china_real_network')),
    chinaToolCallParityDomain(checks.find((check) => check?.name === 'china_tool_call_parity'))
  ]
}

function jetbrainsDomain(check) {
  if (!isRecord(check)) return missingReportDomain('jetbrains_ide_interaction', 'JetBrains real IDE interaction')
  const requiredEnv = asStringArray(check.requiredEnvironment)
  const failures = asStringArray(check.failures)
  const missingEnv = requiredEnv.filter((name) => failures.some((failure) => failure.includes(name)))
  return {
    id: 'jetbrains_ide_interaction',
    title: 'JetBrains real IDE interaction',
    status: check.status === 'ready' ? 'ready' : 'missing_configuration',
    command: stringField(check, 'command') || 'npm.cmd run test:jetbrains-ide-interaction:required',
    requiredEnvironment: requiredEnv,
    missingEnvironment: missingEnv,
    localArtifacts: {
      pluginDistributionPresent: check.pluginDistributionPresent === true,
      ideExecutablePresent: check.ideExecutablePresent === true,
      evidenceJsonValid: check.evidenceJsonValid === true,
      ideExecutable: stringField(check, 'ideExecutable') || undefined,
      ideMetadata: isRecord(check.ideMetadata) ? check.ideMetadata : undefined,
      pluginCompatibility: isRecord(check.pluginCompatibility) ? check.pluginCompatibility : undefined
    },
    failures,
    nextActions: check.status === 'ready'
      ? ['Run npm.cmd run test:jetbrains-ide-interaction:required on this machine.']
      : jetbrainsNextActions(check)
  }
}

function jetbrainsNextActions(check) {
  const actions = []
  if (check.ideExecutablePresent !== true) {
    actions.push('Install or locate a real JetBrains IDE executable such as idea64.exe or webstorm64.exe.')
  }
  const compatibility = isRecord(check.pluginCompatibility) ? check.pluginCompatibility : undefined
  if (compatibility?.compatible === false) {
    actions.push(`Use a JetBrains IDE compatible with the plugin target: ${compatibility.reason}`)
  }
    actions.push('Install the current EastGenesis JetBrains plugin distribution into that IDE.')
  actions.push('Capture real interaction evidence JSON using the template in docs/P2-EXTERNAL-REQUIRED.md.')
  return actions
}

function chinaRealNetworkDomain(check) {
  if (!isRecord(check)) return missingReportDomain('china_real_network', 'China real-network integrations')
  const selectedTargets = Array.isArray(check.selectedTargets) ? check.selectedTargets.filter(isRecord) : []
  const targetGaps = selectedTargets
    .map((target) => ({
      name: stringField(target, 'name'),
      ready: target.ready === true,
      missingRequired: asStringArray(target.missingRequired)
    }))
    .filter((target) => target.name && (!target.ready || target.missingRequired.length > 0))
  const failures = asStringArray(check.failures)
  const missingEnv = unique(targetGaps.flatMap((target) => target.missingRequired))
  if (check.enabled !== true && !missingEnv.includes('CAOGEN_CHINA_REAL_NETWORK')) missingEnv.unshift('CAOGEN_CHINA_REAL_NETWORK')
  if (Array.isArray(check.requiredTargets) && check.requiredTargets.length === 0) {
    missingEnv.push('CAOGEN_CHINA_REAL_NETWORK_REQUIRED_TARGETS')
  }
  return {
    id: 'china_real_network',
    title: 'China real-network integrations',
    status: check.status === 'ready' ? 'ready' : 'missing_configuration',
    command: stringField(check, 'command') || 'npm.cmd run test:china-real-network:required',
    requiredTargets: Array.isArray(check.requiredTargets) ? check.requiredTargets : [],
    missingEnvironment: unique(missingEnv),
    targetGaps,
    failures,
    nextActions: check.status === 'ready'
      ? ['Run npm.cmd run test:china-real-network:required against real public endpoints.']
      : [
          'Set CAOGEN_CHINA_REAL_NETWORK=1 and declare CAOGEN_CHINA_REAL_NETWORK_REQUIRED_TARGETS.',
          'Provide real webhook URLs or API credentials for the staged targets.',
          'Use public HTTPS endpoints; localhost, private IPs, mock hosts, and placeholders are rejected.'
        ]
  }
}

function chinaToolCallParityDomain(check) {
  if (!isRecord(check)) return missingReportDomain('china_tool_call_parity', 'China model tool-call parity')
  const failures = asStringArray(check.failures)
  const requiredEnv = asStringArray(check.requiredEnvironment)
  const missingEnv = requiredEnv
    .map((item) => item.replace(/=1$/, ''))
    .filter((name) => failures.some((failure) => failure.includes(name) || failure.includes(name.replace(/^CAOGEN_/, ''))))
  return {
    id: 'china_tool_call_parity',
    title: 'China model tool-call parity',
    status: check.status === 'ready' ? 'ready' : 'missing_configuration',
    command: stringField(check, 'command') || 'npm.cmd run test:china-tool-call-parity:required',
    providerSource: stringField(check, 'providerSource') || 'missing',
    providerCount: numberField(check, 'providerCount') ?? 0,
    baselineCount: numberField(check, 'baselineCount') ?? 0,
    chinaCount: numberField(check, 'chinaCount') ?? 0,
    protocolCounts: isRecord(check.protocolCounts) ? check.protocolCounts : {},
    thinkingModeCounts: isRecord(check.thinkingModeCounts) ? check.thinkingModeCounts : {},
    privateProviderConfigRedacted: check.privateProviderConfigRedacted === true,
    requiredEnvironment: requiredEnv,
    missingEnvironment: unique(missingEnv.length > 0 ? missingEnv : ['~/.caogen-private/provider-parity.json']),
    failures,
    nextActions: check.status === 'ready'
      ? ['Run npm.cmd run test:china-tool-call-parity:required with real baseline and China providers.']
      : [
          'Create ~/.caogen-private/provider-parity.json with directory mode 0700 and file mode 0600.',
          'Include at least one baseline provider and one China provider with public HTTPS OpenAI-compatible endpoints.'
        ]
  }
}

function missingReportDomain(id, title) {
  return {
    id,
    title,
    status: 'missing_report',
    command: 'npm.cmd run test:p2-external:preflight -- --required',
    requiredEnvironment: [],
    missingEnvironment: [],
    failures: ['missing p2 external preflight report'],
    nextActions: ['Run npm.cmd run test:p2-external:doctor -- --refresh to regenerate the preflight report.']
  }
}

function nextCommandsFor(domains) {
  const commands = ['npm.cmd run test:p2-external:doctor -- --refresh']
  for (const domain of domains) {
    if (domain.status === 'ready') commands.push(domain.command)
  }
  if (domains.every((domain) => domain.status === 'ready')) {
    commands.push('npm.cmd run test:p2-required')
    commands.push('npm.cmd run test:p2-audit -- --required')
  } else {
    commands.push('npm.cmd run test:p2-external:pack')
  }
  return commands
}

function summarizeRequiredGate(report) {
  if (!isRecord(report)) return { exists: false }
  return {
    exists: true,
    status: stringField(report, 'status'),
    runId: stringField(report, 'runId'),
    failures: asStringArray(report.failures),
    environmentConfigurationFailures: asStringArray(report.environmentConfigurationFailures),
    externalConfigurationFailures: asStringArray(report.externalConfigurationFailures)
  }
}

function summarizeAudit(report) {
  if (!isRecord(report)) return { exists: false }
  const requirements = Array.isArray(report.requirements)
    ? report.requirements.filter(isRecord).map((item) => ({
        id: stringField(item, 'id'),
        title: stringField(item, 'title'),
        status: stringField(item, 'status')
      }))
    : []
  return {
    exists: true,
    status: stringField(report, 'status'),
    runId: stringField(report, 'runId'),
    requirements,
    failures: asStringArray(report.failures)
  }
}

function renderMarkdown(report) {
  const lines = [
    '# P2 External Doctor',
    '',
    `Status: ${report.status}`,
    `Run ID: ${report.runId}`,
    `Guide: ${report.configurationGuide}`,
    '',
    '## Domains',
    ''
  ]
  for (const domain of report.domains) {
    lines.push(`### ${domain.title}`)
    lines.push('')
    lines.push(`- Status: ${domain.status}`)
    lines.push(`- Command: \`${domain.command}\``)
    if (domain.missingEnvironment?.length) lines.push(`- Missing env: ${domain.missingEnvironment.map((item) => `\`${item}\``).join(', ')}`)
    if (domain.failures?.length) {
      lines.push('- Failures:')
      for (const failure of domain.failures) lines.push(`  - ${failure}`)
    }
    if (domain.nextActions?.length) {
      lines.push('- Next actions:')
      for (const action of domain.nextActions) lines.push(`  - ${action}`)
    }
    lines.push('')
  }
  lines.push('## Next Commands')
  lines.push('')
  for (const command of report.nextCommands) lines.push(`- \`${command}\``)
  lines.push('')
  return `${lines.join('\n')}\n`
}

function readJson(relativePath) {
  const filePath = path.join(repoRoot, relativePath)
  if (!existsSync(filePath)) return { exists: false, path: relativePath }
  try {
    return {
      exists: true,
      path: relativePath,
      value: JSON.parse(readFileSync(filePath, 'utf8'))
    }
  } catch (error) {
    return {
      exists: true,
      path: relativePath,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function sourceSummary(source) {
  return {
    path: source.path,
    exists: source.exists,
    status: stringField(source.value, 'status'),
    error: source.error
  }
}

function unique(items) {
  return [...new Set(items.filter(Boolean))]
}

function asStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

function stringField(record, key) {
  return isRecord(record) && typeof record[key] === 'string' ? record[key] : undefined
}

function numberField(record, key) {
  return isRecord(record) && typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : undefined
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function tail(text) {
  if (!text) return undefined
  const trimmed = text.trim()
  return trimmed.length > 4000 ? trimmed.slice(-4000) : trimmed
}
