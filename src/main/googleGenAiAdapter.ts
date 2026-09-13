import { createHash } from 'node:crypto'
import { NativeProviderHttpError } from './model/native-http-refusal'
import type {
  AnthropicMessagesContentBlock,
  AnthropicMessagesMessage,
  AnthropicMessagesRequest,
  AnthropicMessagesResult,
  AnthropicMessagesStreamInput,
  AnthropicMessagesToolResultBlock,
  AnthropicMessagesToolUseBlock
} from './anthropicMessagesAdapter'
import { ProviderRequestDeadline } from './provider/providerRequestTimeout'

interface GooglePart extends Record<string, unknown> {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> }
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> }
}

interface GoogleContent {
  role: 'user' | 'model'
  parts: GooglePart[]
}

export interface GoogleGenerateContentRequest extends Record<string, unknown> {
  contents: GoogleContent[]
  systemInstruction?: GoogleContent
  generationConfig?: Record<string, unknown>
  tools?: Array<{ functionDeclarations: Array<Record<string, unknown>> }>
}

export class GoogleGenAiHttpError extends NativeProviderHttpError {
  readonly name = 'GoogleGenAiHttpError'
  constructor(readonly status: number, message: string) {
    super(status, `Google Generative Language returned ${status}: ${message}`)
  }
}

export class GoogleGenAiProtocolError extends Error {
  readonly name = 'GoogleGenAiProtocolError'
}

export function buildGoogleGenerateContentRequest(
  request: AnthropicMessagesRequest
): GoogleGenerateContentRequest {
  const toolNames = new Map<string, string>()
  const contents = request.messages.map((message) => googleContent(message, toolNames))
  const generationConfig = cleanObject({
    ...optionalRecord(request.extraBody?.generationConfig),
    maxOutputTokens: request.maxTokens,
    temperature: request.temperature,
    topP: request.topP,
    topK: request.topK
  })
  return {
    ...(request.extraBody ?? {}),
    contents,
    ...(request.system ? { systemInstruction: { role: 'user', parts: [{ text: request.system }] } } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    ...(request.tools?.length ? {
      tools: [{
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          parametersJsonSchema: tool.input_schema
        }))
      }]
    } : {})
  }
}

export async function streamGoogleGenAiMessage(
  input: AnthropicMessagesStreamInput
): Promise<AnthropicMessagesResult> {
  const deadline = new ProviderRequestDeadline(input.signal, input.timeouts ?? {}, true)
  try {
    const rawResponse = await (input.fetch ?? fetch)(input.endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: input.headers,
      body: JSON.stringify(buildGoogleGenerateContentRequest(input.request)),
      signal: deadline.signal
    })
    const response = deadline.wrapResponse(rawResponse)
    if (!response.ok) throw new GoogleGenAiHttpError(response.status, await boundedResponseError(response))
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!response.body || !contentType.includes('text/event-stream')) {
      return consumeGoogleResponse(await response.json(), input)
    }
    return await consumeGoogleSse(response.body, input)
  } catch (error) {
    throw deadline.errorOr(error)
  } finally {
    deadline.finish()
  }
}

function googleContent(message: AnthropicMessagesMessage, toolNames: Map<string, string>): GoogleContent {
  const role = message.role === 'assistant' ? 'model' : 'user'
  const blocks: AnthropicMessagesContentBlock[] = typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message.content
  return { role, parts: blocks.map((block) => googlePart(block, role, toolNames)) }
}

function googlePart(
  block: AnthropicMessagesContentBlock,
  role: GoogleContent['role'],
  toolNames: Map<string, string>
): GooglePart {
  if (block.type === 'text') return { text: block.text }
  if (block.type === 'image') {
    return { inlineData: { mimeType: block.source.media_type, data: block.source.data } }
  }
  if (block.type === 'thinking') {
    if (role !== 'model' || !block.signature) {
      throw new GoogleGenAiProtocolError('Google thought replay requires a model role and thought signature')
    }
    return { text: block.thinking, thought: true, thoughtSignature: block.signature }
  }
  if (block.type === 'redacted_thinking') {
    throw new GoogleGenAiProtocolError('Google native requests cannot replay Anthropic redacted thinking blocks')
  }
  if (block.type === 'tool_use') {
    toolNames.set(block.id, block.name)
    const signature = optionalText((block as AnthropicMessagesToolUseBlock & { signature?: string }).signature)
    return {
      functionCall: { id: block.id, name: block.name, args: block.input },
      ...(signature ? { thoughtSignature: signature } : {})
    }
  }
  return googleFunctionResponse(block, toolNames)
}

function googleFunctionResponse(
  block: AnthropicMessagesToolResultBlock,
  toolNames: Map<string, string>
): GooglePart {
  const name = toolNames.get(block.tool_use_id)
  if (!name) throw new GoogleGenAiProtocolError(`tool result ${block.tool_use_id} has no preceding function call`)
  const output = toolResultText(block.content)
  return {
    functionResponse: {
      id: block.tool_use_id,
      name,
      response: block.is_error ? { error: output } : { output }
    }
  }
}

function toolResultText(content: AnthropicMessagesToolResultBlock['content']): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  const text: string[] = []
  for (const block of content) {
    if (block.type !== 'text') {
      throw new GoogleGenAiProtocolError('multimodal tool results are not yet supported by the Google adapter')
    }
    text.push(block.text)
  }
  return text.join('\n')
}

async function consumeGoogleSse(
  body: ReadableStream<Uint8Array>,
  input: AnthropicMessagesStreamInput
): Promise<AnthropicMessagesResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const state = emptyState()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split(/\r?\n\r?\n/)
    buffer = frames.pop() ?? ''
    for (const frame of frames) consumeGoogleFrame(frame, state, input)
  }
  buffer += decoder.decode()
  if (buffer.trim()) consumeGoogleFrame(buffer, state, input)
  return resultFromState(state)
}

function consumeGoogleFrame(frame: string, state: GoogleStreamState, input: AnthropicMessagesStreamInput): void {
  const data = frame.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim()
  if (!data) return
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    throw new GoogleGenAiProtocolError('Google stream contains invalid JSON')
  }
  consumeGoogleChunk(value, state, input)
}

function consumeGoogleResponse(value: unknown, input: AnthropicMessagesStreamInput): AnthropicMessagesResult {
  const state = emptyState()
  consumeGoogleChunk(value, state, input)
  return resultFromState(state)
}

function consumeGoogleChunk(value: unknown, state: GoogleStreamState, input: AnthropicMessagesStreamInput): void {
  const response = requiredRecord(value, 'Google response')
  const candidates = Array.isArray(response.candidates) ? response.candidates : []
  if (candidates.length === 0) throw new GoogleGenAiProtocolError('Google response has no candidate')
  if (candidates.length !== 1) throw new GoogleGenAiProtocolError('Google response must contain exactly one candidate')
  const candidate = requiredRecord(candidates[0], 'Google candidate')
  const content = requiredRecord(candidate.content, 'Google candidate content')
  if (content.role !== undefined && content.role !== 'model') {
    throw new GoogleGenAiProtocolError('Google candidate role must be model')
  }
  const parts = Array.isArray(content.parts) ? content.parts : []
  for (const raw of parts) consumeGooglePart(raw, state, input)
  state.id = optionalText(response.responseId) ?? state.id
  state.stopReason = mapFinishReason(optionalText(candidate.finishReason), state.toolUses.length > 0)
  if (response.usageMetadata !== undefined) state.usage = googleUsage(response.usageMetadata)
}

function consumeGooglePart(raw: unknown, state: GoogleStreamState, input: AnthropicMessagesStreamInput): void {
  const part = requiredRecord(raw, 'Google response part')
  const signature = optionalText(part.thoughtSignature)
  if (typeof part.text === 'string') {
    if (part.thought === true) {
      state.thinking += part.text
      appendGoogleThinkingBlock(state, part.text, signature)
      input.onThinking?.(part.text)
    } else {
      state.text += part.text
      state.contentBlocks.push({ type: 'text', text: part.text })
      input.onText?.(part.text)
    }
    return
  }
  if (part.functionCall) {
    consumeGoogleFunctionCall(part.functionCall, state, signature)
    return
  }
  if (signature) appendGoogleThinkingBlock(state, '', signature)
}

function consumeGoogleFunctionCall(raw: unknown, state: GoogleStreamState, signature?: string): void {
  const call = requiredRecord(raw, 'Google function call')
  const name = requiredText(call.name, 'Google function call name')
  const input = call.args === undefined ? {} : requiredRecord(call.args, 'Google function call args')
  const id = optionalText(call.id) ?? syntheticCallId(name, input, state.toolUses.length)
  if (state.seenToolIds.has(id)) throw new GoogleGenAiProtocolError(`duplicate Google function call id: ${id}`)
  const toolUse: AnthropicMessagesToolUseBlock & { signature?: string } = {
    type: 'tool_use', id, name, input, ...(signature ? { signature } : {})
  }
  state.seenToolIds.add(id)
  state.toolUses.push(toolUse)
  state.contentBlocks.push(toolUse)
}

function resultFromState(state: GoogleStreamState): AnthropicMessagesResult {
  if (state.contentBlocks.length === 0) throw new GoogleGenAiProtocolError('Google response content is empty')
  if (state.thinking && !state.thinkingSignature) {
    throw new GoogleGenAiProtocolError('Google thought response is missing its replay signature')
  }
  return {
    id: state.id,
    text: state.text,
    thinking: state.thinking,
    contentBlocks: state.contentBlocks,
    toolUses: state.toolUses,
    stopReason: state.stopReason ?? (state.toolUses.length > 0 ? 'tool_use' : 'end_turn'),
    usage: state.usage
  }
}

function googleUsage(value: unknown): AnthropicMessagesResult['usage'] {
  const usage = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
  return {
    input: nonNegativeInteger(usage.promptTokenCount),
    output: nonNegativeInteger(usage.candidatesTokenCount) + nonNegativeInteger(usage.thoughtsTokenCount),
    cacheRead: nonNegativeInteger(usage.cachedContentTokenCount),
    cacheCreation: 0
  }
}

function mapFinishReason(value: string | undefined, hasTools: boolean): string | undefined {
  if (!value || value === 'FINISH_REASON_UNSPECIFIED') return hasTools ? 'tool_use' : undefined
  if (value === 'STOP') return hasTools ? 'tool_use' : 'end_turn'
  if (value === 'MAX_TOKENS') return 'max_tokens'
  throw new GoogleGenAiProtocolError(`Google generation stopped with ${value}`)
}

async function boundedResponseError(response: Response): Promise<string> {
  const text = (await response.text()).slice(0, 4096)
  try {
    const record = requiredRecord(JSON.parse(text), 'Google error response')
    const error = record.error ? requiredRecord(record.error, 'Google nested error') : record
    return (optionalText(error.message) ?? response.statusText ?? 'request failed').slice(0, 512)
  } catch {
    return response.statusText || 'request failed'
  }
}

function syntheticCallId(name: string, input: Record<string, unknown>, index: number): string {
  const digest = createHash('sha256').update(`${name}\0${JSON.stringify(input)}\0${index}`).digest('hex').slice(0, 16)
  return `gemini-call-${digest}`
}

interface GoogleStreamState {
  id?: string
  text: string
  thinking: string
  contentBlocks: AnthropicMessagesResult['contentBlocks']
  toolUses: AnthropicMessagesToolUseBlock[]
  stopReason?: string
  usage: AnthropicMessagesResult['usage']
  seenToolIds: Set<string>
  thinkingBlock?: Extract<AnthropicMessagesContentBlock, { type: 'thinking' }>
  thinkingSignature?: string
}

function emptyState(): GoogleStreamState {
  return {
    text: '', thinking: '', contentBlocks: [], toolUses: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, seenToolIds: new Set()
  }
}

function appendGoogleThinkingBlock(
  state: GoogleStreamState,
  text: string,
  signature: string | undefined
): void {
  if (signature && state.thinkingSignature && state.thinkingSignature !== signature) {
    throw new GoogleGenAiProtocolError('Google thought response changed replay signature mid-stream')
  }
  if (!state.thinkingBlock) {
    state.thinkingBlock = { type: 'thinking', thinking: text, ...(signature ? { signature } : {}) }
    state.contentBlocks.push(state.thinkingBlock)
  } else {
    state.thinkingBlock.thinking += text
    if (signature) state.thinkingBlock.signature = signature
  }
  if (signature) state.thinkingSignature = signature
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GoogleGenAiProtocolError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new GoogleGenAiProtocolError(`${label} is required`)
  return value
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function cleanObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
