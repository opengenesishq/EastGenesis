#!/usr/bin/env node
/**
 * Opt-in Provider integration probe. The default path is deliberately
 * network-free; only EASTGENESIS_RUN_REAL_PROVIDER=1 can read the private config.
 * CAOGEN_RUN_REAL_PROVIDER=1 remains accepted as a migration alias.
 * This probe is evidence of connectivity/model discovery, never production
 * availability or release readiness.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolvePrivateProviderConfig, PrivateProviderConfigError } from './lib/private-provider-config.mjs'

const reportDir = join(process.cwd(), 'test-results', 'provider-integration-harness')
const reportPath = join(reportDir, 'real-latest.json')
const hash = (value) => createHash('sha256').update(String(value)).digest('hex')
const publicTarget = (url) => ({ kind: 'sha256', sha256: hash(url) })
const emit = (report, code = 0) => {
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify({ ...report, generatedAt: new Date().toISOString(), reportPath }, null, 2)}\n`)
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
  process.exitCode = code
}

const realOptIn = process.env.EASTGENESIS_RUN_REAL_PROVIDER === '1' || process.env.CAOGEN_RUN_REAL_PROVIDER === '1'
if (!realOptIn) {
  emit({ schemaVersion: 1, kind: 'caogen.provider-integration-real-report', status: 'blocked', functionalPassed: false,
    reason: 'opt_in_required', networkRequests: 0, evidence: [], limitations: ['Set EASTGENESIS_RUN_REAL_PROVIDER=1 to opt in; CAOGEN_RUN_REAL_PROVIDER=1 remains a migration alias; this command never opts in implicitly.'] }); process.exit(0)
} else {
  let raw
  try { raw = resolvePrivateProviderConfig().text } catch (error) {
    const reason = error instanceof PrivateProviderConfigError ? error.code : 'provider_config_unreadable'
    emit({ schemaVersion: 1, kind: 'caogen.provider-integration-real-report', status: 'blocked', functionalPassed: false, reason, networkRequests: 0, evidence: [], limitations: ['Private config is read only from ~/.caogen-private/provider-parity.json.'] }, 2); process.exit(2)
  }
  let entries
  try { entries = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch {
    emit({ schemaVersion: 1, kind: 'caogen.provider-integration-real-report', status: 'blocked', functionalPassed: false, reason: 'provider_config_invalid', networkRequests: 0, evidence: [] }, 2); process.exit(2)
  }
  const candidates = Array.isArray(entries) ? entries.filter((item) => item && item.group === 'baseline' && ['openai-compatible', 'openai-responses'].includes(item.apiFormat) && typeof item.baseUrl === 'string' && typeof item.model === 'string' && typeof item.apiKey === 'string') : []
  if (candidates.length < 2) {
    emit({ schemaVersion: 1, kind: 'caogen.provider-integration-real-report', status: 'blocked', functionalPassed: false, reason: 'eligible_baseline_missing', networkRequests: 0, evidence: [] }, 2); process.exit(2)
  }
  const roles = ['planner', 'builder', 'reviewer', 'publisher']
  const valid = candidates.filter((item) => { try { const url = new URL(item.baseUrl); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash } catch { return false } })
  const probe = async (item, role) => {
    const base = item.baseUrl.replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses|models)$/i, '')
    const endpoint = `${base}/models`
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch(endpoint, { method: 'GET', headers: { authorization: `Bearer ${item.apiKey}`, accept: 'application/json' }, signal: controller.signal })
      return { role, ok: response.ok, status: response.status, providerTarget: publicTarget(item.baseUrl), modelDigest: hash(item.model), apiFormat: item.apiFormat }
    } catch (error) { return { role, ok: false, error: error?.name === 'AbortError' ? 'timeout' : 'network_error', providerTarget: publicTarget(item.baseUrl), modelDigest: hash(item.model), apiFormat: item.apiFormat } }
    finally { clearTimeout(timer) }
  }
  const primary = valid[0], backup = valid[1]
  const evidence = await Promise.all(roles.map((role) => probe(primary, role)))
  const primaryFailed = evidence.some((item) => !item.ok)
  const failover = primaryFailed ? await Promise.all(roles.filter((_, index) => !evidence[index].ok).map((role) => probe(backup, role))) : []
  const passed = evidence.filter((item) => item.ok).length + failover.filter((item) => item.ok).length
  emit({ schemaVersion: 1, kind: 'caogen.provider-integration-real-report', status: passed > 0 ? 'functional_probe_passed_formal_binding_pending' : 'failed', functionalPassed: passed > 0, networkRequests: evidence.length + failover.length, parallelRoles: roles.length, evidence, failover, failoverAttempted: primaryFailed, limitations: ['GET /models proves bounded connectivity only; it does not prove task completion, billing, recovery or production SLA.', 'Route Receipt and identity checks remain covered by the synthetic contract report.'] }, passed > 0 ? 0 : 1)
}
