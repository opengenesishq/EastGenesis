import type { ProviderDiagnosticGenerationProtocol } from '../../shared/types'

const MAX_RESPONSE_BYTES = 64 * 1024

/** Inspect a bounded JSON envelope without returning or persisting provider content. */
export async function validateGenerationProbeResponse(
  response: Response,
  protocol: ProviderDiagnosticGenerationProtocol,
  signal: AbortSignal
): Promise<boolean> {
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if ((contentType && contentType !== 'application/json' && !contentType.endsWith('+json')) ||
      Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES || !response.body) {
    void response.body?.cancel().catch(() => undefined)
    return false
  }
  const reader = response.body.getReader()
  let onAbort: () => void = () => undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Generation probe timed out'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    signal.throwIfAborted()
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted])
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > MAX_RESPONSE_BYTES) return false
      chunks.push(chunk.value)
    }
    let body: unknown
    try { body = JSON.parse(Buffer.concat(chunks, length).toString('utf8')) }
    catch { return false }
    return validEnvelope(body, protocol)
  } finally {
    signal.removeEventListener('abort', onAbort)
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function validEnvelope(value: unknown, protocol: ProviderDiagnosticGenerationProtocol): boolean {
  if (!record(value) || value.error != null) return false
  if (protocol === 'openai-responses') {
    return value.object === 'response' && nonempty(value.id) && Array.isArray(value.output) &&
      (value.status === 'completed' || (value.status === 'incomplete' &&
        record(value.incomplete_details) && value.incomplete_details.reason === 'max_output_tokens')) &&
      value.output.every(validResponsesOutput)
  }
  if (protocol === 'openai-chat-completions') {
    return Array.isArray(value.choices) && value.choices.length > 0 && value.choices.some((choice) =>
      record(choice) && record(choice.message) && choice.message.role === 'assistant' &&
      (typeof choice.message.content === 'string' || typeof choice.message.refusal === 'string' ||
        (Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length > 0)))
  }
  if (protocol === 'anthropic-messages') {
    return value.type === 'message' && value.role === 'assistant' && nonempty(value.id) &&
      Array.isArray(value.content) && value.content.every(validAnthropicContent) &&
      (value.stop_reason === 'end_turn' || value.stop_reason === 'max_tokens' ||
        value.stop_reason === 'stop_sequence' || value.stop_reason === 'tool_use')
  }
  return Array.isArray(value.candidates) && value.candidates.length > 0 && value.candidates.some((candidate) =>
    record(candidate) && record(candidate.content) && Array.isArray(candidate.content.parts) &&
    candidate.content.parts.length > 0 && candidate.content.parts.some((part) => record(part) &&
      (typeof part.text === 'string' || record(part.functionCall))))
}

function validResponsesOutput(value: unknown): boolean {
  if (!record(value)) return false
  if (value.type === 'message') return value.role === 'assistant' && Array.isArray(value.content) &&
    value.content.every((part) => record(part) && ((part.type === 'output_text' && typeof part.text === 'string') ||
      (part.type === 'refusal' && typeof part.refusal === 'string')))
  if (value.type === 'reasoning') return Array.isArray(value.summary) && value.summary.every((part) =>
    record(part) && part.type === 'summary_text' && typeof part.text === 'string')
  return value.type === 'function_call' && nonempty(value.name) && nonempty(value.call_id) && typeof value.arguments === 'string'
}

function validAnthropicContent(value: unknown): boolean {
  if (!record(value)) return false
  if (value.type === 'text') return typeof value.text === 'string'
  if (value.type === 'thinking') return typeof value.thinking === 'string'
  if (value.type === 'redacted_thinking') return typeof value.data === 'string'
  return value.type === 'tool_use' && nonempty(value.id) && nonempty(value.name) && record(value.input)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
