import { createHash } from 'node:crypto'
import { domainToASCII } from 'node:url'
import { z } from 'zod'
import type { HostedSiteAnalytics, HostedSiteChange, HostedSiteDescriptor, HostedSiteRange } from '../../shared/hosted-site-types'
import { containsSensitiveText } from '../security/secret-redaction'

export const HOSTED_SITE_PROTOCOL = 'caogen-site-management/1' as const
const text = z.string().min(1).max(2048).refine(value => !/[\x00-\x1f\x7f]/.test(value) && !containsSensitiveText(value), 'Invalid text or credential value')
const identity = text.max(512), instant = z.string().datetime({ offset: true })
const boolean = z.boolean().default(false)
export function hostedDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex') }
function canonical(value: unknown): unknown {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value
}
export function hostedHostname(value: string): string {
  if (typeof value !== 'string') throw new Error('请输入明确域名。')
  const hostname = domainToASCII(value.trim().toLowerCase())
  if (hostname.length > 253 || !hostname.includes('.') || hostname.split('.').some(part => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) || /^[\d.]+$/.test(hostname)) throw new Error('仅支持完整域名，不支持 URL、IP 或通配符。')
  return hostname
}
const url = text.refine(value => { try { const parsed = new URL(value); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash } catch { return false } }, 'Invalid public URL')
const hostname = text.refine(value => { try { return hostedHostname(value) === value } catch { return false } })
const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
const descriptorSchema = z.object({
  adapterNamespace: identity, accountScope: identity, accountName: text, siteId: identity, name: text,
  revision: identity, deploymentId: identity.optional(), url: url.optional(), observedAt: instant, deleted: z.boolean(),
  capabilities: z.object({ domainRead: boolean, domainBind: boolean, domainUnbind: boolean, accessRead: boolean, accessSetPublic: boolean,
    accessDisable: boolean, analytics: boolean, deleteSite: boolean, inspectOperation: boolean, idempotentOperations: boolean, conditionalMutations: boolean,
    environmentRead: boolean, environmentSet: boolean, environmentRemove: boolean }).strict(),
  domains: z.array(z.object({ hostname, status: z.enum(['pending', 'verified', 'failed', 'unknown']), dnsInstructions: text.optional(), observedAt: instant }).strict()).max(100),
  access: z.object({ mode: z.enum(['public', 'disabled', 'unknown']), description: text }).strict(),
  environment: z.array(z.object({ name: environmentName, secret: z.boolean(), revision: identity, updatedAt: instant }).strict()).max(200).optional(),
  environmentRequiresRedeploy: z.boolean().optional()
}).strict()
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
const analyticsSchema = z.object({ source: text, methodology: text, from: instant, to: instant, timeZone: text.max(100), generatedAt: instant, sampled: z.boolean(),
  pageViews: count, uniqueVisitors: count, daily: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), pageViews: count, uniqueVisitors: count }).strict()).max(366) }).strict()
export function validateHostedDescriptor(value: unknown): HostedSiteDescriptor {
  const parsed = descriptorSchema.parse(value)
  if (new Set(parsed.domains.map(domain => domain.hostname)).size !== parsed.domains.length) throw new Error('适配器域名列表有重复值。')
  if (new Set(parsed.environment?.map(item => item.name)).size !== (parsed.environment?.length ?? 0)) throw new Error('适配器环境变量列表有重复名称。')
  if (parsed.capabilities.environmentRead && !parsed.environment) throw new Error('适配器未返回环境变量元数据。')
  return parsed
}
export function validateHostedRange(value: HostedSiteRange): HostedSiteRange {
  const parsed = z.object({ from: instant, to: instant, timeZone: text.max(100) }).strict().parse(value)
  if (Date.parse(parsed.to) <= Date.parse(parsed.from) || Date.parse(parsed.to) - Date.parse(parsed.from) > 366 * 86400000) throw new Error('统计范围须为 1 毫秒至 366 天。')
  new Intl.DateTimeFormat('en', { timeZone: parsed.timeZone }).format()
  return parsed
}
export function validateHostedAnalytics(value: unknown, range: HostedSiteRange): HostedSiteAnalytics {
  const parsed = analyticsSchema.parse(value)
  if (Date.parse(parsed.from) !== Date.parse(range.from) || Date.parse(parsed.to) !== Date.parse(range.to) || parsed.timeZone !== range.timeZone) throw new Error('统计回执与请求时间范围不匹配。')
  if (new Set(parsed.daily.map(day => day.date)).size !== parsed.daily.length) throw new Error('统计日期重复。')
  return parsed
}
export function validateHostedChange(input: HostedSiteChange): HostedSiteChange {
  if (!input || typeof input !== 'object') throw new Error('站点变更无效。')
  if (input.kind === 'domain.bind' || input.kind === 'domain.unbind') {
    z.object({ kind: z.string(), hostname: z.string() }).strict().parse(input)
    return { kind: input.kind, hostname: hostedHostname(input.hostname) }
  }
  return z.discriminatedUnion('kind', [z.object({ kind: z.literal('access.set'), mode: z.enum(['public', 'disabled']) }).strict(), z.object({ kind: z.literal('site.delete') }).strict(),
    z.object({ kind: z.literal('environment.set'), name: environmentName, secret: z.boolean(), valueRef: z.string().uuid() }).strict(),
    z.object({ kind: z.literal('environment.remove'), name: environmentName }).strict()]).parse(input)
}
export function assertHostedCapability(site: HostedSiteDescriptor, change: HostedSiteChange): void {
  const c = site.capabilities
  if (site.deleted) throw new Error('站点已删除。')
  if (!c.inspectOperation || !c.conditionalMutations || !c.idempotentOperations) throw new Error('适配器未提供幂等操作、版本条件变更及原操作核对；仅可读取。')
  const supported = change.kind === 'domain.bind' ? c.domainBind : change.kind === 'domain.unbind' ? c.domainUnbind : change.kind === 'site.delete' ? c.deleteSite
    : change.kind === 'environment.set' ? c.environmentRead && c.environmentSet : change.kind === 'environment.remove' ? c.environmentRead && c.environmentRemove : change.mode === 'public' ? c.accessSetPublic : c.accessDisable
  if (!supported) throw new Error('当前适配器不支持此站点变更。')
  if (change.kind === 'domain.bind' && site.domains.some(domain => domain.hostname === change.hostname)) throw new Error('该域名已绑定。')
  if (change.kind === 'domain.unbind' && !site.domains.some(domain => domain.hostname === change.hostname)) throw new Error('该域名不属于原站点。')
  if (change.kind === 'environment.remove' && !site.environment?.some(item => item.name === change.name)) throw new Error('该变量不在此站点的环境中。')
}
export function hostedSiteKey(site: HostedSiteDescriptor): string { return hostedDigest([site.adapterNamespace, site.accountScope, site.siteId]) }
export function assertHostedAfter(before: HostedSiteDescriptor, after: HostedSiteDescriptor, change: HostedSiteChange): void {
  if (hostedSiteKey(before) !== hostedSiteKey(after)) throw new Error('变更回执的站点或账户身份不匹配。')
  if (change.kind === 'site.delete') { if (!after.deleted || after.access.mode !== 'disabled') throw new Error('删除回执没有确认站点删除及访问关闭。'); return }
  if (after.deleted || after.deploymentId !== before.deploymentId) throw new Error('变更回执意外改变站点存续或部署身份。')
  const domains = (site: HostedSiteDescriptor): string[] => site.domains.map(domain => domain.hostname).sort()
  const environment = (site: HostedSiteDescriptor) => [...(site.environment ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  if (change.kind === 'environment.set' || change.kind === 'environment.remove') {
    if (hostedDigest(domains(before)) !== hostedDigest(domains(after)) || before.access.mode !== after.access.mode) throw new Error('环境变量回执意外改变域名或访问状态。')
    const beforeOther = environment(before).filter(item => item.name !== change.name), afterOther = environment(after).filter(item => item.name !== change.name)
    if (hostedDigest(beforeOther) !== hostedDigest(afterOther)) throw new Error('环境变量回执修改了未确认的其他变量。')
    const prior = before.environment?.find(item => item.name === change.name), next = after.environment?.find(item => item.name === change.name)
    if (change.kind === 'environment.remove' ? !!next : !next || next.secret !== change.secret || next.revision === prior?.revision) throw new Error('环境变量回执未确认目标变量的变更。')
  } else if (change.kind === 'access.set') {
    if (after.access.mode !== change.mode || hostedDigest(domains(before)) !== hostedDigest(domains(after))) throw new Error('访问策略回执包含不匹配或额外的域名变更。')
  } else {
    const expected = change.kind === 'domain.bind' ? [...domains(before), change.hostname].sort() : domains(before).filter(domain => domain !== change.hostname)
    if (hostedDigest(expected) !== hostedDigest(domains(after)) || before.access.mode !== after.access.mode) throw new Error('域名回执包含不匹配或额外的访问策略变更。')
  }
  if (change.kind !== 'environment.set' && change.kind !== 'environment.remove' && hostedDigest(environment(before)) !== hostedDigest(environment(after))) throw new Error('站点回执包含未确认的环境变量变更。')
}
export interface HostedRequest {
  protocol: typeof HOSTED_SITE_PROTOCOL; requestId: string; operation: 'describe' | 'analytics' | 'plan' | 'apply' | 'inspect'
  siteId: string; accountScope?: string; operationId?: string; expectedRevision?: string
  change?: HostedSiteChange; planId?: string; planDigest?: string; analytics?: HostedSiteRange
}
export interface HostedResponse { data?: unknown; plan?: { planId: string; expiresAt: string; before: unknown; after: unknown; impact: string[] }; receipt?: { result: 'applied' | 'not_applied' | 'unknown'; after?: unknown } }
export function parseHostedResponse(stdout: string, request: HostedRequest): HostedResponse {
  const rows = stdout.split(/\r?\n/).filter(line => line.startsWith('CAOGEN_SITE_MANAGEMENT_RESULT '))
  if (rows.length !== 1) throw new Error('适配器必须返回且只返回一个结构化管理回执。')
  const value = z.object({ protocol: z.literal(HOSTED_SITE_PROTOCOL), requestId: identity, operation: z.enum(['describe', 'analytics', 'plan', 'apply', 'inspect']), siteId: identity,
    accountScope: identity, operationId: identity.optional(), expectedRevision: identity.optional(), planDigest: identity.optional(),
    data: z.unknown().optional(), plan: z.object({ planId: identity, expiresAt: instant, before: z.unknown(), after: z.unknown(), impact: z.array(text).min(1).max(30) }).strict().optional(),
    receipt: z.object({ result: z.enum(['applied', 'not_applied', 'unknown']), after: z.unknown().optional() }).strict().optional() }).strict().parse(JSON.parse(rows[0].slice('CAOGEN_SITE_MANAGEMENT_RESULT '.length)))
  for (const key of ['requestId', 'operation', 'siteId', 'accountScope', 'operationId', 'expectedRevision', 'planDigest'] as const) if (request[key] !== undefined && value[key] !== request[key]) throw new Error(`管理回执的 ${key} 与原请求不匹配。`)
  if (request.operation === 'describe') { const site = validateHostedDescriptor(value.data); if (site.siteId !== request.siteId || site.accountScope !== value.accountScope) throw new Error('站点描述的身份与回执信封不匹配。') }
  return value
}
