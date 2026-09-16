import type { StudioExecutionAudit, StudioResultSnapshot } from '../../shared/studio-result-types'

const MAX_ROWS = 60

/** Human-readable companion to the exact, structured records in the package. */
export function buildStudioDeliveryChecklist(
  snapshot: StudioResultSnapshot,
  files: ReadonlyArray<Record<string, unknown>>,
  audit?: StudioExecutionAudit
): string {
  const included = files.filter(file => file.contentIncluded === true)
  const omitted = files.filter(file => file.contentIncluded !== true)
  const acceptances = snapshot.acceptances.filter(item => item.deliveryScope !== 'historical')
  const needsReview = acceptances.filter(item => !['passed', 'waived'].includes(item.status))
  const title = snapshot.workItems.length === 1 ? snapshot.workItems[0].title
    : snapshot.goal?.title ?? snapshot.workspace?.name ?? 'CaoGen'
  const lines = [
    '# 交付清单 / Delivery checklist', '',
    `## ${plain(title)}`, '',
    `导出时间 / Exported: ${new Date(snapshot.generatedAt).toISOString()}`, '',
    ...(snapshot.goal?.objective ? [plain(snapshot.goal.objective), ''] : []),
    `已包含文件 / Included files: **${included.length}** · 未包含文件 / Omitted files: **${omitted.length}**`, '',
    '文件按导出时的内容核对。导出成功本身不代表业务验收通过。',
    'Files were checked at export time. Exporting does not by itself approve the deliverables.', '',
    '## 可打开文件 / Included files', ''
  ]
  if (!included.length) lines.push('本包没有可直接交付的文件字节。 / No deliverable file contents are included.', '')
  else {
    lines.push('| 文件 / File | 版本 / Version |', '| --- | --- |')
    for (const file of included.slice(0, MAX_ROWS)) {
      const path = packagePath(file.includedPath)
      lines.push(`| ${path ? `[${plain(file.title)}](<${path}>)` : plain(file.title)} | ${plain(file.version)} |`)
    }
    appendRemaining(lines, included.length)
    lines.push('')
  }
  if (omitted.length) {
    lines.push('## 未包含的文件 / Omitted files', '', '| 文件 / File | 原因 / Reason |', '| --- | --- |')
    for (const file of omitted.slice(0, MAX_ROWS)) {
      const status = String(file.contentStatus ?? '')
      lines.push(`| ${plain(file.title)} · v${plain(file.version)} | ${omissionReason(status)}${status === 'not_deliverable' ? ` (${plain(file.deliveryStatus)})` : ''} |`)
    }
    appendRemaining(lines, omitted.length)
    lines.push('')
  }

  lines.push('## 验收 / Acceptance', '')
  if (!acceptances.length) lines.push('没有验收记录。 / No acceptance decisions are recorded.', '')
  else {
    lines.push(`通过 / Passed: ${acceptances.filter(item => item.status === 'passed').length} · 豁免 / Waived: ${acceptances.filter(item => item.status === 'waived').length} · 待处理 / Needs review: ${needsReview.length}`, '')
    for (const acceptance of acceptances.slice(0, MAX_ROWS)) {
      lines.push(`- **${plain(acceptance.status)}** · v${acceptance.revision}: ${acceptance.criteria.map(plain).join('; ') || plain(acceptance.id)}`)
      if (acceptance.status === 'waived' && acceptance.waiverReason) lines.push(`  豁免原因 / Waiver reason: ${plain(acceptance.waiverReason)}`)
      if (acceptance.notes) lines.push(`  ${plain(acceptance.notes)}`)
    }
    appendRemaining(lines, acceptances.length)
    lines.push('')
  }

  lines.push('## 来源与检查 / Sources and checks', '')
  if (!snapshot.evidence.length && !snapshot.tests.length) lines.push('没有已登记来源或检查记录。 / No sources or checks are recorded.', '')
  for (const evidence of snapshot.evidence.slice(0, MAX_ROWS)) {
    const uri = sourceUrl(evidence.sourceUri)
    lines.push(`- ${uri ? `[${plain(evidence.title)}](<${uri}>)` : plain(evidence.title)}${evidence.sourceContentKind === 'search_snippet' ? ' — 搜索摘要，未核对网页正文 / Search snippet; page text not verified' : ''}`)
    if (evidence.summary) lines.push(`  ${plain(evidence.summary)}`)
  }
  appendRemaining(lines, snapshot.evidence.length)
  for (const test of snapshot.tests.slice(0, MAX_ROWS)) lines.push(`- ${plain(test.title)}: **${plain(test.status)}**`)
  appendRemaining(lines, snapshot.tests.length)

  lines.push('', '## 执行与授权记录 / Execution and permission records', '')
  if (!audit) lines.push('此包没有执行审计记录。 / Execution audit records are unavailable.', '')
  else {
    lines.push(`审计条目 / Audit entries: ${audit.total}`, '',
      '| 范围 / Scope | 记录覆盖 / Recorded coverage |', '| --- | --- |',
      `| 模型调用 / Model calls | ${coverage(audit.coverage.modelAttempts.status)} |`,
      `| 执行器 / Executors | ${coverage(audit.coverage.executors.status)} |`,
      `| 权限决定 / Permission decisions | ${coverage(audit.coverage.permissions.status)} |`,
      `| 费用 / Costs | ${coverage(snapshot.cost.coverage)} |`, '')
    const models = new Map<string, number>()
    for (const item of audit.items.filter(item => item.category === 'model_attempt')) {
      const name = [item.providerId, item.model, item.protocol].filter(Boolean).map(plain).join(' / ') || '未记录 / Unavailable'
      models.set(name, (models.get(name) ?? 0) + 1)
    }
    for (const [name, count] of [...models].slice(0, MAX_ROWS)) lines.push(`- ${name}: ${count} 次记录 / recorded calls`)
    appendRemaining(lines, models.size)
    const tools = audit.items.filter(item => item.category === 'tool')
    const allowed = tools.filter(item => item.permissionDecision === 'allow').length
    const denied = tools.filter(item => item.permissionDecision === 'deny').length
    lines.push('', `工具权限 / Tool permissions: ${allowed} 允许 / allowed · ${denied} 拒绝 / denied · ${tools.length - allowed - denied} 未记录决定 / decision unavailable`, '')
    if (audit.missingReferences) lines.push(`缺失引用 / Missing references: **${audit.missingReferences}**`, '')
    lines.push('完整审计记录见 [execution-audit.json](execution-audit.json)。 / See the full execution audit.', '')
  }

  lines.push('## 模型费用 / Model costs', '')
  lines.push(snapshot.cost.coverage === 'unavailable' ? '未知 / Unavailable'
    : `$${snapshot.cost.knownUsd.toFixed(6)} — ${coverage(snapshot.cost.coverage)}`)
  lines.push('', '来自已记录的模型调用费用，可能包含估算；缺失费用不计为零。',
    'Based on recorded model-call costs, which may contain estimates. Missing costs are not counted as zero.', '')

  lines.push('## 未解决事项 / Outstanding work', '')
  const issues = [...snapshot.openItems, ...snapshot.risks, ...snapshot.approvals]
  const unresolvedEffects = audit?.items.filter(item => item.category === 'effect' && ['prepared', 'executing', 'waiting_reconciliation', 'failed'].includes(item.status)) ?? []
  if (!issues.length && !unresolvedEffects.length) lines.push('当前结果快照没有已登记的未解决事项。 / No outstanding items are recorded in this snapshot.', '')
  else {
    for (const issue of issues.slice(0, MAX_ROWS)) lines.push(`- ${plain(issue.title)}: **${plain(issue.status)}** (${plain(issue.severity)})`)
    appendRemaining(lines, issues.length)
    lines.push('')
  }
  if (unresolvedEffects.length) {
    lines.push('以下操作尚未确认完成；结果未知时应先核对原操作。 / These operations are not confirmed complete; reconcile unknown outcomes before proceeding.', '')
    for (const effect of unresolvedEffects.slice(0, MAX_ROWS)) lines.push(`- ${plain(effect.toolName ?? effect.action)}: **${plain(effect.status)}** · ${plain(effect.entityId)}`)
    appendRemaining(lines, unresolvedEffects.length)
    lines.push('')
  }
  lines.push('## 记录文件 / Supporting records', '',
    '- [manifest.json](manifest.json): 文件清单、内容摘要与包内位置 / File inventory, digests and package paths.',
    '- [result.json](result.json): 本次任务的成果、版本、来源与验收快照 / Task results, versions, sources and acceptance snapshot.',
    ...(audit ? ['- [execution-audit.json](execution-audit.json): 本次任务的执行审计 / Task execution audit.'] : []), '')
  return lines.join('\n')
}

function plain(value: unknown): string {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([`*_\[\]{}|])/g, '\\$1')
}

function packagePath(value: unknown): string | undefined {
  return typeof value === 'string' && /^artifacts\/[a-zA-Z0-9\u4e00-\u9fff._-]+$/.test(value) ? value : undefined
}

function sourceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href.replace(/[<>\s]/g, character => encodeURIComponent(character)) : undefined
  } catch { return undefined }
}

function coverage(value: string): string {
  const labels: Record<string, string> = { complete: '记录完整 / Complete records', partial: '部分记录 / Partial records', unavailable: '未知 / Unavailable' }
  return labels[value] ?? plain(value)
}

function omissionReason(value: string): string {
  const labels: Record<string, string> = { not_deliverable: '尚不可交付或属于旧版本 / Not ready or historical',
    digest_mismatch: '文件内容已变化 / File contents changed', package_limit: '超出包大小限制 / Package size limit',
    artifact_too_large: '文件过大 / File too large', not_regular_file: '不是普通文件 / Not a regular file',
    unreadable: '无法读取 / Unreadable', no_available_file_location: '没有可用文件 / No available file' }
  return labels[value] ?? '未包含 / Not included'
}

function appendRemaining(lines: string[], total: number): void {
  if (total > MAX_ROWS) lines.push('', `此清单展示前 ${MAX_ROWS} 项，共 ${total} 项；完整记录见 JSON。 / Showing the first ${MAX_ROWS} of ${total}; see JSON for all records.`)
}
