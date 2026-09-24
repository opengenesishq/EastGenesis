import type { HostedSiteDescriptor } from '../../shared/hosted-site-types'
import { redactSensitiveText } from '../security/secret-redaction'
import { parseHostedResponse, validateHostedAnalytics, validateHostedDescriptor, type HostedRequest } from './hosted-site-protocol'
import type { SiteProcessResult } from './site-deployment-process'

/** Keep the validated protocol receipt, never an adapter's incidental stdout/stderr. */
export function hostedProtocolOutput(output: SiteProcessResult, request: HostedRequest, privateValue?: string, publicPreview?: HostedSiteDescriptor): SiteProcessResult {
  const failure = (): SiteProcessResult => ({ ...output, stdout: '', stderr: '', error: '站点适配器没有返回有效的结构化回执；请核对原操作。' })
  if (output.exitCode !== 0 || output.error || output.outputTruncated) return failure()
  const safeText = (text: string): string => redactSensitiveText(privateValue ? text.split(privateValue).join('[REDACTED]') : text)
  const safeSite = (value: unknown): HostedSiteDescriptor => {
    const site = validateHostedDescriptor(value)
    return { ...site, name: safeText(site.name), accountName: safeText(site.accountName), access: { ...site.access, description: safeText(site.access.description) },
      domains: site.domains.map(domain => ({ ...domain, ...(domain.dnsInstructions ? { dnsInstructions: safeText(domain.dnsInstructions) } : {}) })) }
  }
  try {
    const response = parseHostedResponse(output.stdout, request)
    let accountScope = request.accountScope
    let body: Record<string, unknown>
    if (request.operation === 'describe') { const data = safeSite(response.data); accountScope = data.accountScope; body = { data } }
    else if (request.operation === 'analytics') {
      if (!request.analytics) return failure()
      const data = validateHostedAnalytics(response.data, request.analytics)
      body = { data: { ...data, source: safeText(data.source), methodology: safeText(data.methodology) } }
    } else if (request.operation === 'plan') {
      if (!response.plan) return failure()
      body = { plan: { ...response.plan, before: safeSite(response.plan.before), after: safeSite(response.plan.after), impact: response.plan.impact.map(safeText) } }
    } else {
      if (!response.receipt) return failure()
      body = { receipt: { result: response.receipt.result, ...(response.receipt.after ? { after: safeSite(response.receipt.after) } : {}) } }
    }
    // Values already shown in the value-free preview are public metadata. This
    // lets short values such as "1" coexist with a pre-existing numeric revision,
    // while rejecting any newly echoed private value in an opaque identity.
    const publicStrings = new Set(['applied', 'not_applied', 'unknown'])
    const rememberPublic = (value: unknown): void => {
      if (typeof value === 'string') publicStrings.add(value)
      else if (Array.isArray(value)) value.forEach(rememberPublic)
      else if (value && typeof value === 'object') Object.values(value).forEach(rememberPublic)
    }
    rememberPublic(request); rememberPublic(publicPreview)
    const containsPrivateValue = (value: unknown, key = ''): boolean => {
      if (typeof value === 'string') {
        // Validated timestamps are public observations. A short numeric setting
        // may coincide with a date digit; it is not an opaque adapter field.
        if ((key === 'observedAt' || key === 'updatedAt') && privateValue && /^\d{1,3}$/.test(privateValue)
          && Math.abs(Date.parse(value) - Date.now()) < 60_000) return false
        return !!privateValue && value.includes(privateValue) && !publicStrings.has(value)
      }
      return Array.isArray(value) ? value.some(item => containsPrivateValue(item))
        : !!value && typeof value === 'object' && Object.entries(value).some(([name, item]) => containsPrivateValue(item, name))
    }
    if (containsPrivateValue(body)) return failure()
    return { ...output, error: undefined, stderr: '', stdout: 'CAOGEN_SITE_MANAGEMENT_RESULT ' + JSON.stringify({ protocol: request.protocol, requestId: request.requestId,
      operation: request.operation, siteId: request.siteId, accountScope, operationId: request.operationId, expectedRevision: request.expectedRevision, planDigest: request.planDigest, ...body }) }
  } catch (cause) {
    const result = failure(), message = cause instanceof Error ? cause.message : ''
    if (/^管理回执的 (requestId|operation|siteId|accountScope|operationId|expectedRevision|planDigest) 与原请求不匹配。$/.test(message)) result.error = message
    return result
  }
}
