const REQUIREMENT_ID = /^[A-Z][A-Z0-9-]+-\d+$/
const PRIORITY = /^P[01]$/
const CRITICAL_RECOVERY_REQUIREMENTS = new Set([
  'RUN-004', 'RUN-005',
  'TRUST-002', 'TRUST-003', 'TRUST-004',
  'ART-002',
  'NFR-REC-001', 'NFR-REC-002', 'NFR-REC-003', 'NFR-REC-004', 'NFR-REC-005'
])
const RESILIENCE_PATTERNS = {
  kill: /strong[- ]?kill|crash|restart|power loss|enospc/i,
  network: /network|remote|provider|connector/i,
  duplicate: /duplicate|idempoten|replay/i,
  outOfOrder: /out[- ]of[- ]order|reorder|stale|fencing|\bcas\b/i
}

export function buildAcceptanceMap({ prdMarkdown, matrixMarkdown, packageScripts, expectedCounts }) {
  const requirements = parseRequirements(prdMarkdown)
  const matrixRows = parseMatrixRows(matrixMarkdown)
  const rowsById = groupById(matrixRows)
  const entries = requirements.map((requirement) => buildEntry(requirement, rowsById, packageScripts))
  const requirementIds = new Set(requirements.map((item) => item.id))
  const unexpectedMatrixIds = [...rowsById.keys()].filter((id) => !requirementIds.has(id)).sort()
  const structuralFailures = [
    ...checkInventoryCounts(entries, expectedCounts),
    ...collectStructuralFailures(entries, unexpectedMatrixIds)
  ]
  const closureFailures = collectClosureFailures(entries)
  return {
    entries,
    unexpectedMatrixIds,
    structuralFailures,
    closureFailures,
    summary: summarize(entries)
  }
}

function checkInventoryCounts(entries, expectedCounts) {
  if (!expectedCounts) return []
  const failures = []
  for (const priority of ['P0', 'P1']) {
    const actual = entries.filter((entry) => entry.priority === priority).length
    if (actual !== expectedCounts[priority]) {
      failures.push(`${priority} inventory changed: expected ${expectedCounts[priority]}, got ${actual}`)
    }
  }
  return failures
}

export function parseRequirements(markdown) {
  const rows = []
  for (const line of markdown.split(/\r?\n/)) {
    const cells = splitMarkdownRow(line)
    if (cells.length !== 4) continue
    const id = normalizeCell(cells[0])
    const priority = normalizeCell(cells[1])
    if (!REQUIREMENT_ID.test(id) || !PRIORITY.test(priority)) continue
    rows.push({
      id,
      priority,
      status: normalizeCell(cells[2]),
      requirement: normalizeCell(cells[3])
    })
  }
  return rows
}

export function parseMatrixRows(markdown) {
  const rows = []
  for (const line of markdown.split(/\r?\n/)) {
    const cells = splitMarkdownRow(line)
    if (cells.length !== 7 && cells.length !== 8) continue
    const id = normalizeCell(cells[0])
    if (!REQUIREMENT_ID.test(id)) continue
    const hasSelection = cells.length === 8
    const statusIndex = hasSelection ? 2 : 1
    rows.push({
      id,
      selection: hasSelection ? normalizeCell(cells[1]) : 'P0',
      status: normalizeCell(cells[statusIndex]),
      evidence: normalizeCell(cells[statusIndex + 1]),
      owner: normalizeCell(cells[statusIndex + 2]),
      gateClass: normalizeCell(cells[statusIndex + 3]),
      gate: normalizeCell(cells[statusIndex + 4]),
      dependencies: normalizeCell(cells[statusIndex + 5])
    })
  }
  return rows
}

function buildEntry(requirement, rowsById, packageScripts) {
  const rows = rowsById.get(requirement.id) ?? []
  const matrix = rows[0]
  const declaredCommands = matrix ? extractCommands(matrix.gate) : []
  const missingCommands = declaredCommands.filter((command) => packageScripts[command] === undefined)
  const explicitHumanGate = matrix ? hasExplicitHumanGate(matrix) : false
  const mapped = Boolean(matrix && (declaredCommands.length > 0 || explicitHumanGate))
  const statusMatches = Boolean(matrix && matrix.status === requirement.status)
  const waiver = matrix ? parseWaiver(matrix) : { declared: false, approved: false }
  return {
    ...requirement,
    matrix: matrix ?? null,
    matrixRowCount: rows.length,
    declaredCommands,
    implementedCommands: declaredCommands.filter((command) => packageScripts[command] !== undefined),
    missingCommands,
    mapped,
    statusMatches,
    releaseBoundEvidence: matrix ? isReleaseBoundEvidence(matrix) : false,
    resilience: resilienceCoverage(requirement.id, matrix),
    waiver
  }
}

function extractCommands(gate) {
  const commands = new Set()
  const commandName = '[A-Za-z0-9:._-]*[A-Za-z0-9:_-]'
  for (const match of gate.matchAll(new RegExp(`npm run\\s+(${commandName})`, 'g'))) commands.add(match[1])
  for (const match of gate.matchAll(new RegExp(`\\b(test:${commandName})`, 'g'))) commands.add(match[1])
  return [...commands].sort()
}

function hasExplicitHumanGate(matrix) {
  if (/HUMAN-TIME|EXT-CRED|EXT-HW|MIXED/.test(matrix.gateClass)) return true
  return /\b(human|manual|real user|real provider|approval|review|drill|soak)\b/i.test(matrix.gate)
}

function isReleaseBoundEvidence(matrix) {
  const text = `${matrix.evidence} ${matrix.gate} ${matrix.dependencies}`.toLowerCase()
  const staleMarkers = [
    'dirty worktree',
    'refresh in clean',
    'repeat in clean',
    'waits for release commit',
    'final binding waits',
    'add gate',
    'no required',
    'not proved',
    'absent',
    'incomplete',
    'remain open',
    'missing'
  ]
  return matrix.status === '当前已验证' && !staleMarkers.some((marker) => text.includes(marker))
}

function parseWaiver(matrix) {
  const text = `${matrix.selection} ${matrix.status} ${matrix.gate} ${matrix.dependencies}`
  const declared = /waiv|豁免|省略/i.test(text)
  if (!declared) return { declared: false, approved: false }
  const approved = /owner|签署|批准|approved/i.test(text) && /reason|理由/i.test(text) && /expiry|到期/i.test(text)
  return { declared, approved }
}

function resilienceCoverage(id, matrix) {
  const required = CRITICAL_RECOVERY_REQUIREMENTS.has(id)
  const text = matrix ? `${matrix.evidence} ${matrix.gate} ${matrix.dependencies}` : ''
  const cases = Object.fromEntries(
    Object.entries(RESILIENCE_PATTERNS).map(([name, pattern]) => [name, pattern.test(text)])
  )
  return { required, cases }
}

function collectStructuralFailures(entries, unexpectedMatrixIds) {
  const failures = unexpectedMatrixIds.map((id) => `matrix contains unknown requirement ${id}`)
  for (const entry of entries) {
    if (entry.matrixRowCount === 0) failures.push(`${entry.id}: missing matrix row`)
    if (entry.matrixRowCount > 1) failures.push(`${entry.id}: duplicate matrix rows (${entry.matrixRowCount})`)
    if (entry.matrix && !entry.statusMatches) {
      failures.push(`${entry.id}: PRD status ${entry.status} differs from matrix status ${entry.matrix.status}`)
    }
    if (entry.matrix && !entry.mapped) failures.push(`${entry.id}: no automated command or explicit human gate`)
  }
  return failures
}

function collectClosureFailures(entries) {
  const failures = []
  for (const entry of entries) {
    if (entry.priority === 'P0' && entry.status !== '当前已验证') {
      failures.push(`${entry.id}: P0 status is ${entry.status}`)
    }
    if (entry.priority === 'P1' && isOpenP1(entry) && !entry.waiver.approved) {
      failures.push(`${entry.id}: P1 selection is open without an approved waiver`)
    }
    if (entry.missingCommands.length > 0) {
      failures.push(`${entry.id}: missing package scripts ${entry.missingCommands.join(', ')}`)
    }
    if (entry.status === '当前已验证' && !entry.releaseBoundEvidence) {
      failures.push(`${entry.id}: verified status lacks release-bound evidence`)
    }
    if (entry.waiver.declared && !entry.waiver.approved) {
      failures.push(`${entry.id}: waiver lacks owner, reason, approval, or expiry`)
    }
    if (entry.resilience.required) {
      const missing = Object.entries(entry.resilience.cases)
        .filter(([, covered]) => !covered)
        .map(([name]) => name)
      if (missing.length > 0) failures.push(`${entry.id}: missing resilience cases ${missing.join(', ')}`)
    }
  }
  return failures
}

function isOpenP1(entry) {
  if (entry.status === '当前已验证' || entry.status === '条件可用') return false
  return !entry.waiver.approved
}

function summarize(entries) {
  const p0 = entries.filter((entry) => entry.priority === 'P0')
  const p1 = entries.filter((entry) => entry.priority === 'P1')
  const declaredCommands = new Set(entries.flatMap((entry) => entry.declaredCommands))
  const implementedCommands = new Set(entries.flatMap((entry) => entry.implementedCommands))
  return {
    total: entries.length,
    p0: summarizePriority(p0),
    p1: summarizePriority(p1),
    mapped: entries.filter((entry) => entry.mapped).length,
    requirementsWithImplementedGate: entries.filter((entry) => entry.implementedCommands.length > 0).length,
    declaredGateCommands: declaredCommands.size,
    implementedGateCommands: implementedCommands.size,
    releaseBound: entries.filter((entry) => entry.releaseBoundEvidence).length,
    criticalRecovery: summarizeRecovery(entries)
  }
}

function summarizeRecovery(entries) {
  const critical = entries.filter((entry) => entry.resilience.required)
  return {
    total: critical.length,
    complete: critical.filter((entry) => Object.values(entry.resilience.cases).every(Boolean)).length
  }
}

function summarizePriority(entries) {
  return {
    total: entries.length,
    mapped: entries.filter((entry) => entry.mapped).length,
    verified: entries.filter((entry) => entry.status === '当前已验证').length,
    conditional: entries.filter((entry) => entry.status === '条件可用').length,
    targets: entries.filter((entry) => entry.status === '立项目标').length,
    open: entries.filter((entry) => entry.status !== '当前已验证').length
  }
}

function groupById(rows) {
  const grouped = new Map()
  for (const row of rows) grouped.set(row.id, [...(grouped.get(row.id) ?? []), row])
  return grouped
}

function splitMarkdownRow(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return []
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim())
}

function normalizeCell(value) {
  return value.replace(/\*\*/g, '').replace(/`/g, '').trim()
}
