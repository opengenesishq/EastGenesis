export function renderReleaseDoctorMarkdown(value) {
  const lines = [
    '# EastGenesis Work OS Release Doctor',
    '',
    `Status: ${value.status}`,
    `Run ID: ${value.runId}`,
    `Release target: ${value.releaseTarget.label}`,
    `Package version: ${value.currentPackageVersion}`,
    '',
    ...renderDistributionPolicy(value.distributionPolicy),
    '## Refresh',
    '',
    `- Enabled: ${value.refresh.enabled ? 'yes' : 'no'}`,
    ...value.refresh.commands.map((item) => `- ${item.id}: ${item.status} (${item.durationMs}ms)`),
    '',
    '## Domains',
    ''
  ]
  for (const domain of value.domains) lines.push(...renderDomainSection(domain))
  lines.push('## Optional Engines', '')
  lines.push(...value.optionalEngines.map(renderOptionalEngine), '')
  lines.push('## Parallel Agents', '', '| Agent | Branch | Objective | Acceptance |', '|---|---|---|---|')
  lines.push(...value.parallelAgents.map(renderParallelAgent), '')
  lines.push('## Stop Conditions', '')
  lines.push(...value.releaseStopConditions.map((item) => `- ${item}`), '')
  return `${lines.join('\n')}\n`
}

function renderDistributionPolicy(policy) {
  if (!policy) return []
  const scoped = policy.platformScopedRelease
  return [
    '## Distribution Policy',
    '',
    `- Selected channel: \`${policy.selectedReleaseChannel}\``,
    `- Formal cross-platform gate: ${policy.formalCrossPlatform?.status || 'unknown'} (Doctor: ${policy.formalCrossPlatform?.doctorStatus || 'unknown'})`,
    `- Platform-scoped candidate gate: ${scoped?.candidateGate?.status || 'unknown'}`,
    `- Platform-scoped final notes gate: ${scoped?.finalNotesGate?.status || 'unknown'}`,
    `- Platform-scoped post-publication gate: ${scoped?.postPublicationGate?.status || 'unknown'}`,
    `- Windows formal signing plan: ${scoped?.windowsFormalSigningPlan || 'not recorded'}`,
    ''
  ]
}

function renderDomainSection(domain) {
  const lines = [`### ${domain.title}`, '', `- Status: ${domain.status}`]
  if (domain.status === 'waived' && domain.waiver) {
    lines.push(`- Waiver: ${domain.waiver.owner}; version=${domain.waiver.releaseVersion}; decided=${domain.waiver.decidedAt}`)
    lines.push(`- Accepted risk: ${domain.waiver.acceptedRisk}`)
  }
  if (domain.proved?.length) lines.push(`- Proved: ${domain.proved.map((item) => `\`${item}\``).join(', ')}`)
  if (domain.open?.length) lines.push(`- Open: ${domain.open.map((item) => `\`${item.id}:${item.status}\``).join(', ')}`)
  if (domain.nonBlockingOpen?.length) {
    lines.push(`- Non-blocking open: ${domain.nonBlockingOpen.map((item) => `\`${item.id}:${item.releasePolicy}\``).join(', ')}`)
  }
  if (domain.commands?.length) lines.push('- Commands:', ...renderDomainCommands(domain.commands))
  if (domain.nextActions?.length) lines.push('- Next actions:', ...domain.nextActions.map((action) => `  - ${action}`))
  lines.push('')
  return lines
}

function renderOptionalEngine(engine) {
  return `- ${engine.id}: release required=${engine.releaseRequired ? 'yes' : 'no'}; default selected=${engine.defaultSelected ? 'yes' : 'no'}. ${engine.policy}`
}

function renderParallelAgent(agent) {
  return `| ${agent.id} | \`${agent.branch}\` | ${agent.objective} | ${agent.acceptance} |`
}

function renderDomainCommands(commands) {
  return commands.map((command) => {
    if (typeof command === 'string') return `  - \`${command}\``
    if (!command || typeof command !== 'object') return null
    const duration = typeof command.durationMs === 'number' ? ` (${command.durationMs}ms)` : ''
    return `  - \`${command.id || 'unknown'}\`: ${command.status || 'unknown'}${duration}`
  }).filter(Boolean)
}
