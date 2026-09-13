import { buildAnthropicMessagesWireBody } from './anthropicMessagesRequest'
import { NativeProviderHttpError } from './model/native-http-refusal'
import {
  ProviderRequestDeadline,
  type ProviderRequestTimeouts
} from './provider/providerRequestTimeout'

export interface AnthropicMessagesUsage {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

export interface AnthropicMessagesTextBlock extends Record<string, unknown> {
  type: 'text'
  text: string
}

export interface AnthropicMessagesImageBlock extends Record<string, unknown> {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}

export interface AnthropicMessagesToolUseBlock extends Record<string, unknown> {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  /** Opaque vendor replay signature used by Gemini function-call history. */
  signature?: string
}

export type AnthropicMessagesToolResultContentBlock =
  | AnthropicMessagesTextBlock
  | AnthropicMessagesImageBlock

export interface AnthropicMessagesToolResultBlock extends Record<string, unknown> {
  type: 'tool_result'
  tool_use_id: string
  content?: string | AnthropicMessagesToolResultContentBlock[]
  is_error?: boolean
}

export type AnthropicMessagesContentBlock =
  | AnthropicMessagesTextBlock
  | AnthropicMessagesImageBlock
  | AnthropicMessagesThinkingBlock
  | AnthropicMessagesRedactedThinkingBlock
  | AnthropicMessagesToolUseBlock
  | AnthropicMessagesToolResultBlock

export interface AnthropicMessagesToolInputSchema extends Record<string, unknown> {
  type: 'object'
}

export interface AnthropicMessagesTool {
  name: string
  description?: string
  input_schema: AnthropicMessagesToolInputSchema
}

export interface AnthropicMessagesThinkingBlock extends Record<string, unknown> {
  type: 'thinking'
  thinking: string
  signature?: string
}

export interface AnthropicMessagesRedactedThinkingBlock extends Record<string, unknown> {
  type: 'redacted_thinking'
  data: string
}

export type AnthropicMessagesResultContentBlock =
  | AnthropicMessagesTextBlock
  | AnthropicMessagesThinkingBlock
  | AnthropicMessagesRedactedThinkingBlock
  | AnthropicMessagesToolUseBlock

export interface AnthropicMessagesMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicMessagesContentBlock[]
}

export interface AnthropicMessagesThinkingConfig {
  mode: 'disabled' | 'adaptive' | 'enabled'
  budgetTokens?: number
  display?: 'summarized' | 'omitted'
}

export interface AnthropicMessagesPromptCachingConfig {
  enabled: boolean
  ttl?: '5m' | '1h'
  strategy?: 'automatic' | 'system' | 'tools' | 'last-user'
}

export interface AnthropicMessagesRequest {
  model: string
  maxTokens: number
  messages: AnthropicMessagesMessage[]
  tools?: AnthropicMessagesTool[]
  system?: string
  temperature?: number
  topP?: number
  topK?: number
  thinking?: AnthropicMessagesThinkingConfig
  promptCaching?: AnthropicMessagesPromptCachingConfig
  /** Non-protected provider-specific body fields. */
  extraBody?: Record<string, unknown>
}

export interface AnthropicMessagesResult {
  id?: string
  text: string
  thinking: string
  contentBlocks: AnthropicMessagesResultContentBlock[]
  toolUses: AnthropicMessagesToolUseBlock[]
  stopReason?: string
  usage: AnthropicMessagesUsage
}

export interface AnthropicMessagesStreamInput {
  endpoint: string
  headers: Record<string, string>
  request: AnthropicMessagesRequest
  signal: AbortSignal
  onText?: (text: string) => void
  onThinking?: (text: string) => void
  fetch?: typeof fetch
  timeouts?: ProviderRequestTimeouts
}

export { buildAnthropicMessagesWireBody } from './anthropicMessagesRequest'

export class AnthropicMessagesHttpError extends NativeProviderHttpError {
  readonly name = 'AnthropicMessagesHttpError'

  constructor(readonly status: number, message: string) {
    super(status, `Anthropic Messages 返回 ${status}: ${message}`)
  }
}

export class AnthropicMessagesProtocolError extends Error {
  readonly name = 'AnthropicMessagesProtocolError'
}

export async function streamAnthropicMessage(
  input: AnthropicMessagesStreamInput
): Promise<AnthropicMessagesResult> {
  const wireBody = buildAnthropicMessagesWireBody(input.request)
  const deadline = new ProviderRequestDeadline(input.signal, input.timeouts ?? {}, true)
  try {
    const rawResponse = await (input.fetch ?? fetch)(input.endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: input.headers,
      body: JSON.stringify(wireBody),
      signal: deadline.signal
    })
    const response = deadline.wrapResponse(rawResponse)
    if (!response.ok) throw new AnthropicMessagesHttpError(response.status, await responseError(response))

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!response.body || (contentType && !contentType.includes('text/event-stream'))) {
      return await consumeJsonResponse(await response.json(), input)
    }
    return await consumeSseResponse(response.body, input)
  } catch (error) {
    throw deadline.errorOr(error)
  } finally {
    deadline.finish()
  }
}

async function consumeSseResponse(
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
    for (const frame of frames) consumeFrame(frame, state, input)
  }
  buffer += decoder.decode()
  if (buffer.trim()) consumeFrame(buffer, state, input)
  if (!state.stopped) throw new AnthropicMessagesProtocolError('stream ended before message_stop')
  return resultFromState(state)
}

function consumeFrame(
  frame: string,
  state: StreamState,
  input: AnthropicMessagesStreamInput
): void {
  const lines = frame.split(/\r?\n/)
  const eventName = lines
    .filter((line) => line.startsWith('event:'))
    .map((line) => line.slice(6).trim())
    .filter(Boolean)
    .at(-1)
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim()
  if (!data || data === '[DONE]') return
  let event: Record<string, unknown>
  try {
    event = JSON.parse(data) as Record<string, unknown>
  } catch {
    throw new AnthropicMessagesProtocolError('stream contains invalid JSON')
  }
  const type = requiredText(event.type, 'stream event type')
  if (eventName && eventName !== type) {
    throw new AnthropicMessagesProtocolError(`stream event name ${eventName} does not match payload type ${type}`)
  }
  consumeEvent(event, state, input)
}

function consumeEvent(
  event: Record<string, unknown>,
  state: StreamState,
  input: AnthropicMessagesStreamInput
): void {
  const type = requiredText(event.type, 'stream event type')
  if (state.stopped) throw new AnthropicMessagesProtocolError(`stream event ${type} arrived after message_stop`)
  const handler = STREAM_EVENT_HANDLERS[type]
  if (!handler) throw new AnthropicMessagesProtocolError(`unsupported Anthropic stream event: ${type}`)
  handler(event, state, input)
}

type StreamEventHandler = (
  event: Record<string, unknown>,
  state: StreamState,
  input: AnthropicMessagesStreamInput
) => void

const STREAM_EVENT_HANDLERS: Record<string, StreamEventHandler> = {
  error: handleStreamError,
  ping: () => undefined,
  message_start: handleMessageStart,
  content_block_start: handleContentBlockStart,
  content_block_delta: handleContentBlockDelta,
  content_block_stop: handleContentBlockStop,
  message_delta: handleMessageDelta,
  message_stop: handleMessageStop
}

function handleStreamError(event: Record<string, unknown>): never {
  const error = recordField(event.error)
  throw new AnthropicMessagesProtocolError(textField(error?.message) || 'provider stream error')
}

function handleMessageStart(event: Record<string, unknown>, state: StreamState): void {
  if (state.started) throw new AnthropicMessagesProtocolError('stream contains duplicate message_start')
  const message = requiredRecord(event.message, 'message_start message')
  if (
    message.type !== 'message'
    || message.role !== 'assistant'
    || !Array.isArray(message.content)
    || message.content.length !== 0
  ) {
    throw new AnthropicMessagesProtocolError('message_start message envelope is invalid')
  }
  state.id = requiredText(message.id, 'message_start id')
  mergeUsage(state.usage, requiredRecord(message.usage, 'message_start usage'), {
    label: 'message_start usage',
    requireInput: true,
    requireOutput: true
  })
  state.started = true
}

function handleContentBlockStart(
  event: Record<string, unknown>,
  state: StreamState,
  input: AnthropicMessagesStreamInput
): void {
  assertStreamingContentPhase(state, 'content_block_start')
  const index = blockIndex(event.index, 'content_block_start')
  if (state.activeBlock) {
    throw new AnthropicMessagesProtocolError(
      `content block ${index} started before content block ${state.activeBlock.index} stopped`
    )
  }
  if (index !== state.nextBlockIndex) {
    const detail = index < state.nextBlockIndex ? 'started more than once' : 'started out of order'
    throw new AnthropicMessagesProtocolError(`content block ${index} ${detail}`)
  }
  const block = requiredRecord(event.content_block, 'content_block_start content_block')
  const blockType = contentBlockType(block.type)
  if (blockType === 'text') {
    const text = optionalText(block.text, 'text content block')
    state.activeBlock = { index, type: 'text', text }
    emitText(text, input)
    return
  }
  if (blockType === 'thinking') {
    const thinking = optionalText(block.thinking, 'thinking content block')
    state.activeBlock = { index, type: 'thinking', thinking, signature: '' }
    emitThinking(thinking, input)
    return
  }
  if (blockType === 'redacted_thinking') {
    state.activeBlock = {
      index,
      type: 'redacted_thinking',
      data: requiredOpaqueText(block.data, 'redacted_thinking data')
    }
    return
  }

  const id = requiredText(block.id, 'tool_use id')
  if (state.seenToolUseIds.has(id)) {
    throw new AnthropicMessagesProtocolError(`tool_use id ${id} appeared more than once`)
  }
  const initialInput = requiredRecord(block.input, 'tool_use input')
  if (Object.keys(initialInput).length > 0) {
    throw new AnthropicMessagesProtocolError('streaming tool_use input must start as an empty object')
  }
  state.seenToolUseIds.add(id)
  state.activeBlock = {
    index,
    type: 'tool_use',
    id,
    name: requiredText(block.name, 'tool_use name'),
    inputJson: ''
  }
}

function handleContentBlockDelta(
  event: Record<string, unknown>,
  state: StreamState,
  input: AnthropicMessagesStreamInput
): void {
  assertStreamingContentPhase(state, 'content_block_delta')
  const index = blockIndex(event.index, 'content_block_delta')
  const block = activeBlockAt(state, index, 'delta')
  const delta = requiredRecord(event.delta, 'content_block_delta delta')
  const deltaType = requiredText(delta.type, 'content block delta type')
  if (block.type === 'text' && deltaType === 'text_delta') {
    const text = optionalText(delta.text, 'text delta')
    block.text += text
    emitText(text, input)
    return
  }
  if (block.type === 'thinking' && deltaType === 'thinking_delta') {
    const thinking = optionalText(delta.thinking, 'thinking delta')
    block.thinking += thinking
    emitThinking(thinking, input)
    return
  }
  if (block.type === 'thinking' && deltaType === 'signature_delta') {
    block.signature += requiredText(delta.signature, 'thinking signature delta')
    return
  }
  if (block.type === 'tool_use' && deltaType === 'input_json_delta') {
    block.inputJson += optionalText(delta.partial_json, 'tool_use input_json_delta partial_json')
    return
  }
  throw new AnthropicMessagesProtocolError(`content block ${index} received ${deltaType} for ${block.type}`)
}

function handleContentBlockStop(event: Record<string, unknown>, state: StreamState): void {
  assertStreamingContentPhase(state, 'content_block_stop')
  const index = blockIndex(event.index, 'content_block_stop')
  const block = activeBlockAt(state, index, 'stop')
  if (block.type === 'text') {
    state.contentBlocks.push({ type: 'text', text: block.text })
  } else if (block.type === 'thinking') {
    state.contentBlocks.push({
      type: 'thinking',
      thinking: block.thinking,
      ...(block.signature ? { signature: block.signature } : {})
    })
  } else if (block.type === 'redacted_thinking') {
    state.contentBlocks.push({ type: 'redacted_thinking', data: block.data })
  } else {
    const toolUse: AnthropicMessagesToolUseBlock = {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: parseToolInput(block.inputJson, `content block ${index} tool_use input`)
    }
    state.contentBlocks.push(toolUse)
    state.toolUses.push(toolUse)
  }
  state.activeBlock = undefined
  state.nextBlockIndex += 1
}

function handleMessageDelta(event: Record<string, unknown>, state: StreamState): void {
  assertMessageStarted(state, 'message_delta')
  if (state.messageDeltaSeen) throw new AnthropicMessagesProtocolError('stream contains duplicate message_delta')
  if (state.activeBlock) {
    throw new AnthropicMessagesProtocolError('message_delta arrived before all content blocks stopped')
  }
  if (state.contentBlocks.length === 0) {
    throw new AnthropicMessagesProtocolError('message_delta arrived before any content block')
  }
  const delta = requiredRecord(event.delta, 'message_delta delta')
  state.stopReason = stopReason(delta.stop_reason)
  assertToolStopReason(state)
  assertStopSequence(delta.stop_sequence)
  mergeUsage(state.usage, requiredRecord(event.usage, 'message_delta usage'), {
    label: 'message_delta usage',
    requireOutput: true
  })
  state.messageDeltaSeen = true
}

function handleMessageStop(_event: Record<string, unknown>, state: StreamState): void {
  assertMessageStarted(state, 'message_stop')
  if (!state.messageDeltaSeen || state.activeBlock || state.contentBlocks.length === 0) {
    throw new AnthropicMessagesProtocolError('message_stop arrived before a complete message_delta sequence')
  }
  if (!hasResponseContent(state)) {
    throw new AnthropicMessagesProtocolError('message_stop completed an empty response')
  }
  state.stopped = true
}

function consumeJsonResponse(value: unknown, input: AnthropicMessagesStreamInput): AnthropicMessagesResult {
  const message = recordField(value)
  if (!message) throw new AnthropicMessagesProtocolError('response is not an object')
  if (message.type === 'error') {
    const error = recordField(message.error)
    throw new AnthropicMessagesProtocolError(textField(error?.message) || 'provider response error')
  }
  if (message.type !== 'message' || message.role !== 'assistant') {
    throw new AnthropicMessagesProtocolError('response message envelope is invalid')
  }
  const state = emptyState()
  state.started = true
  state.id = requiredText(message.id, 'response message id')
  state.stopReason = stopReason(message.stop_reason)
  mergeUsage(state.usage, requiredRecord(message.usage, 'response usage'), {
    label: 'response usage',
    requireInput: true,
    requireOutput: true
  })
  if (!Array.isArray(message.content) || message.content.length === 0) {
    throw new AnthropicMessagesProtocolError('response content must be a non-empty array')
  }
  for (const raw of message.content) {
    consumeJsonContentBlock(requiredRecord(raw, 'response content block'), state, input)
  }
  assertToolStopReason(state)
  if (!hasResponseContent(state)) throw new AnthropicMessagesProtocolError('response content is empty')
  state.messageDeltaSeen = true
  state.stopped = true
  return resultFromState(state)
}

function consumeJsonContentBlock(
  block: Record<string, unknown>,
  state: StreamState,
  input: AnthropicMessagesStreamInput
): void {
  if (block.type === 'text') {
    const text = optionalText(block.text, 'response text block')
    state.contentBlocks.push({ type: 'text', text })
    emitText(text, input)
    return
  }
  if (block.type === 'thinking') {
    const thinking = optionalText(block.thinking, 'response thinking block')
    const signature = optionalNullableText(block.signature, 'response thinking signature')
    state.contentBlocks.push({
      type: 'thinking',
      thinking,
      ...(signature ? { signature } : {})
    })
    emitThinking(thinking, input)
    return
  }
  if (block.type === 'redacted_thinking') {
    state.contentBlocks.push({
      type: 'redacted_thinking',
      data: requiredOpaqueText(block.data, 'response redacted_thinking data')
    })
    return
  }
  if (block.type === 'tool_use') {
    consumeJsonToolUseBlock(block, state)
    return
  }
  throw new AnthropicMessagesProtocolError(
    `unsupported Anthropic content block type: ${String(block.type)}`
  )
}

function consumeJsonToolUseBlock(block: Record<string, unknown>, state: StreamState): void {
  const id = requiredText(block.id, 'response tool_use id')
  if (state.seenToolUseIds.has(id)) {
    throw new AnthropicMessagesProtocolError(`tool_use id ${id} appeared more than once`)
  }
  const toolUse: AnthropicMessagesToolUseBlock = {
    type: 'tool_use',
    id,
    name: requiredText(block.name, 'response tool_use name'),
    input: requiredRecord(block.input, 'response tool_use input')
  }
  state.seenToolUseIds.add(id)
  state.contentBlocks.push(toolUse)
  state.toolUses.push(toolUse)
}

interface StreamState {
  id?: string
  stopReason?: string
  started: boolean
  messageDeltaSeen: boolean
  stopped: boolean
  activeBlock?: ActiveContentBlock
  nextBlockIndex: number
  contentBlocks: AnthropicMessagesResultContentBlock[]
  toolUses: AnthropicMessagesToolUseBlock[]
  seenToolUseIds: Set<string>
  usage: AnthropicMessagesUsage
}

type ActiveContentBlock =
  | { index: number; type: 'text'; text: string }
  | { index: number; type: 'thinking'; thinking: string; signature: string }
  | { index: number; type: 'redacted_thinking'; data: string }
  | { index: number; type: 'tool_use'; id: string; name: string; inputJson: string }

function emptyState(): StreamState {
  return {
    started: false,
    messageDeltaSeen: false,
    stopped: false,
    nextBlockIndex: 0,
    contentBlocks: [],
    toolUses: [],
    seenToolUseIds: new Set(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  }
}

function emitText(text: string, input: AnthropicMessagesStreamInput): void {
  if (!text) return
  input.onText?.(text)
}

function emitThinking(thinking: string, input: AnthropicMessagesStreamInput): void {
  if (!thinking) return
  input.onThinking?.(thinking)
}

function mergeUsage(
  target: AnthropicMessagesUsage,
  raw: Record<string, unknown>,
  options: { label: string; requireInput?: boolean; requireOutput?: boolean }
): void {
  target.input = Math.max(target.input, usageCount(raw, 'input_tokens', options.label, options.requireInput))
  target.output = Math.max(target.output, usageCount(raw, 'output_tokens', options.label, options.requireOutput))
  target.cacheRead = Math.max(
    target.cacheRead,
    usageCount(raw, 'cache_read_input_tokens', options.label, false)
  )
  target.cacheCreation = Math.max(
    target.cacheCreation,
    usageCount(raw, 'cache_creation_input_tokens', options.label, false)
  )
}

function resultFromState(state: StreamState): AnthropicMessagesResult {
  const contentBlocks = state.contentBlocks.map(cloneResultContentBlock)
  const text = contentBlocks
    .filter((block): block is AnthropicMessagesTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
  const thinking = contentBlocks
    .filter((block): block is AnthropicMessagesThinkingBlock => block.type === 'thinking')
    .map((block) => block.thinking)
    .join('')
  return {
    id: state.id,
    text,
    thinking,
    contentBlocks,
    toolUses: contentBlocks.filter(
      (block): block is AnthropicMessagesToolUseBlock => block.type === 'tool_use'
    ),
    stopReason: state.stopReason,
    usage: { ...state.usage }
  }
}

function activeBlockAt(state: StreamState, index: number, action: 'delta' | 'stop'): ActiveContentBlock {
  if (!state.activeBlock) {
    throw new AnthropicMessagesProtocolError(`content block ${index} ${action} arrived before its start`)
  }
  if (state.activeBlock.index !== index) {
    throw new AnthropicMessagesProtocolError(
      `content block ${index} ${action} arrived while content block ${state.activeBlock.index} is active`
    )
  }
  return state.activeBlock
}

function parseToolInput(value: string, label: string): Record<string, unknown> {
  if (!value) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new AnthropicMessagesProtocolError(`${label} is not valid JSON`)
  }
  const input = recordField(parsed)
  if (!input) throw new AnthropicMessagesProtocolError(`${label} must be a JSON object`)
  return input
}

function hasResponseContent(state: StreamState): boolean {
  return state.toolUses.length > 0 || state.contentBlocks.some((block) => {
    if (block.type === 'text') return Boolean(block.text)
    if (block.type === 'thinking') return Boolean(block.thinking)
    return true
  })
}

function assertToolStopReason(state: StreamState): void {
  const hasToolUses = state.toolUses.length > 0
  if (hasToolUses !== (state.stopReason === 'tool_use')) {
    throw new AnthropicMessagesProtocolError(
      hasToolUses
        ? 'response containing tool_use blocks must stop with tool_use'
        : 'tool_use stop_reason requires at least one tool_use block'
    )
  }
}

function cloneResultContentBlock(
  block: AnthropicMessagesResultContentBlock
): AnthropicMessagesResultContentBlock {
  if (block.type === 'tool_use') return { ...block, input: { ...block.input } }
  return { ...block }
}

async function responseError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    const error = recordField(value.error)
    return textField(error?.message) || textField(value.message) || response.statusText
  } catch {
    return text || response.statusText
  }
}

function usageCount(
  raw: Record<string, unknown>,
  key: string,
  label: string,
  required = false
): number {
  const value = raw[key]
  if (value === undefined && !required) return 0
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AnthropicMessagesProtocolError(`${label} ${key} is invalid`)
  }
  return value
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  const record = recordField(value)
  if (!record) throw new AnthropicMessagesProtocolError(`${label} is not an object`)
  return record
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AnthropicMessagesProtocolError(`${label} is missing or invalid`)
  }
  return value.trim()
}

function optionalText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new AnthropicMessagesProtocolError(`${label} is invalid`)
  return value
}

function optionalNullableText(value: unknown, label: string): string {
  if (value === undefined || value === null) return ''
  return optionalText(value, label)
}

function requiredOpaqueText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AnthropicMessagesProtocolError(`${label} is missing or invalid`)
  }
  return value
}

function blockIndex(value: unknown, eventType: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AnthropicMessagesProtocolError(`${eventType} index is invalid`)
  }
  return value as number
}

function contentBlockType(value: unknown): 'text' | 'thinking' | 'redacted_thinking' | 'tool_use' {
  const type = requiredText(value, 'content block type')
  if (type !== 'text' && type !== 'thinking' && type !== 'redacted_thinking' && type !== 'tool_use') {
    throw new AnthropicMessagesProtocolError(`unsupported Anthropic content block type: ${type}`)
  }
  return type
}

function assertStopSequence(value: unknown): void {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new AnthropicMessagesProtocolError('message_delta stop_sequence is invalid')
  }
}

function assertMessageStarted(state: StreamState, eventType: string): void {
  if (!state.started) throw new AnthropicMessagesProtocolError(`${eventType} arrived before message_start`)
}

function assertStreamingContentPhase(state: StreamState, eventType: string): void {
  assertMessageStarted(state, eventType)
  if (state.messageDeltaSeen) {
    throw new AnthropicMessagesProtocolError(`${eventType} arrived after message_delta`)
  }
}

function stopReason(value: unknown): string {
  const reason = requiredText(value, 'stop_reason')
  if (!new Set([
    'end_turn',
    'max_tokens',
    'stop_sequence',
    'tool_use',
    'pause_turn',
    'refusal',
    'model_context_window_exceeded'
  ]).has(reason)) {
    throw new AnthropicMessagesProtocolError(`unsupported stop_reason: ${reason}`)
  }
  return reason
}
