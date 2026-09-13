import type { ProviderModelPricing } from '../../shared/types'
import { ModelRouteError } from './model-route-error'

export function assertNativeRequestContext(body: unknown, contextWindow?: number): void {
  if (!contextWindow) return
  const request = parsedRequest(body)
  if (!request) throw new Error('Native request body cannot be inspected for context limits')
  const output = outputLimit(request)
  if (output !== undefined && Buffer.byteLength(JSON.stringify(request), 'utf8') + output > contextWindow) {
    throw new ModelRouteError('ROUTING_CAPABILITY_UNAVAILABLE', '完整请求与显式输出上限超过已声明上下文容量；请缩短上下文或调整输出上限。')
  }
}

/** No media-token or hidden output-limit guesses: finite budgets require a
 * declared USD token price and an explicit output bound on the wire request. */
export function estimateNativeRequestUpperCost(body: unknown, pricing: ProviderModelPricing | undefined): number | undefined {
  if (!pricing) return undefined
  const request = parsedRequest(body)
  if (!request) return undefined
  const maxOutput = outputLimit(request)
  if (!maxOutput) return undefined
  const serialized = JSON.stringify(request)
  if (/"(?:image_url|inlineData|input_image|input_audio|image|audio|file_data)"\s*:/.test(serialized)) return undefined
  const inputBytes = Buffer.byteLength(serialized, 'utf8')
  return (inputBytes * Math.max(pricing.inputPerMillion, pricing.cacheReadPerMillion ?? 0, pricing.cacheWritePerMillion ?? 0)
    + maxOutput * pricing.outputPerMillion) / 1_000_000
}

function outputLimit(object: Record<string, unknown>): number | undefined {
  const generation = object.generationConfig && typeof object.generationConfig === 'object'
    ? object.generationConfig as Record<string, unknown> : {}
  return positive(object.max_completion_tokens) ?? positive(object.max_output_tokens) ?? positive(object.max_tokens) ?? positive(object.maxTokens) ?? positive(generation.maxOutputTokens)
}

function parsedRequest(body: unknown): Record<string, unknown> | undefined {
  let value = body
  if (typeof body === 'string') { try { value = JSON.parse(body) } catch { return undefined } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}


function positive(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined }
