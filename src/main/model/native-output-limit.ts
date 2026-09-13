const DEFAULT_OUTPUT_TOKENS = 8192

/** Bound the actual wire request after user runtime overrides, so finite USD reservations have an output ceiling. */
export function boundedOpenAiRequestBody(body: RequestInit['body'], protocol: string, baseUrl: string): RequestInit['body'] {
  if (typeof body !== 'string') return body
  const value: unknown = JSON.parse(body)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return body
  const request = value as Record<string, unknown>
  if (['max_output_tokens', 'max_completion_tokens', 'max_tokens'].some((key) => request[key] !== undefined)) return body
  const key = protocol === 'openai.responses' ? 'max_output_tokens'
    : new URL(baseUrl).hostname === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens'
  return JSON.stringify({ ...request, [key]: DEFAULT_OUTPUT_TOKENS })
}
