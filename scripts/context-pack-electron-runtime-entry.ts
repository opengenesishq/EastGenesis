import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { contextPackPath } from '../src/main/agent/context-pack-persistence'
import { OpenAIEngine } from '../src/main/openaiEngine'
import type { ChatMessage } from '../src/main/openAiEngineTypes'
import type { SessionMeta } from '../src/shared/types'

const SESSION_ID = 'electron-context-pack-runtime-fixture'
const MODEL = 'mock-8k'
const SUMMARY = 'Electron mock 摘要：早期目标、决策和待办已被持久化。'
const RECENT: ChatMessage[] = [
  { role: 'user', content: '保留的最近用户消息 A' },
  { role: 'assistant', content: '保留的最近助手消息 A' },
  { role: 'user', content: '保留的最近用户消息 B' },
  { role: 'assistant', content: '保留的最近助手消息 B' },
  { role: 'user', content: '保留的最近用户消息 C' },
  { role: 'assistant', content: '保留的最近助手消息 C' },
  { role: 'user', content: '保留的最近用户消息 D' },
  { role: 'assistant', content: '保留的最近助手消息 D' },
  { role: 'user', content: '保留的最近用户消息 E' },
  { role: 'assistant', content: '保留的最近助手消息 E' },
  { role: 'user', content: '保留的最近用户消息 F' },
  { role: 'assistant', content: '保留的最近助手消息 F' }
]

function meta(): SessionMeta {
  return {
    id: SESSION_ID,
    title: 'Electron Context Pack runtime fixture',
    cwd: process.cwd(),
    model: MODEL,
    providerId: 'mock-provider',
    routingScope: 'fixed',
    taskStrategy: 'execute',
    permissionMode: 'default',
    status: 'idle',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: Date.now()
  }
}

function engine(emit: (event: unknown) => void, resume = false): any {
  const value = new OpenAIEngine(meta(), emit as any, resume ? SESSION_ID : undefined)
  return value as any
}

function emitHistory(value: any): void {
  value.emitSyntheticEvent({ kind: 'init', sdkSessionId: SESSION_ID, model: MODEL })
  for (let i = 0; i < 7; i += 1) {
    const body = `旧历史 ${i} `.repeat(260)
    value.emitSyntheticEvent({ kind: 'user-message', messageId: `old-user-${i}`, text: body })
    value.emitSyntheticEvent({ kind: 'assistant-message', blocks: [{ type: 'text', text: `旧回答 ${i} `.repeat(260) }] })
  }
  for (const message of RECENT) {
    value.emitSyntheticEvent(message.role === 'user'
      ? { kind: 'user-message', text: String(message.content) }
      : { kind: 'assistant-message', blocks: [{ type: 'text', text: String(message.content) }] })
  }
}

export async function run(stage: 'write' | 'read', userData: string): Promise<void> {
  if (stage === 'write') {
    const emitted: unknown[] = []
    const value = engine((event) => emitted.push(event))
    emitHistory(value)
    const older: ChatMessage[] = Array.from({ length: 14 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `旧历史 ${i} `.repeat(900)
    } as ChatMessage))
    ;(value as any).chatHistory = [...older, ...RECENT]
    ;(value as any).summarize = async () => SUMMARY
    await (value as any).compressHistoryIfNeeded({ provider: undefined }, { role: 'system', content: 'fixture' })
    const file = contextPackPath(userData, SESSION_ID)
    if (!existsSync(file)) throw new Error('compression did not persist a Context Pack')
    const pack = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (pack.summary !== SUMMARY) throw new Error('persisted summary mismatch')
    console.log(JSON.stringify({ stage, sessionId: SESSION_ID, boundarySeq: pack.boundarySeq, trailingRuntimeEvents: emitted.length, digest: pack.digest }))
    return
  }

  const emitted: unknown[] = []
  const value = engine((event) => emitted.push(event), true)
  const history = (value as any).chatHistory as ChatMessage[]
  if (history[0]?.role !== 'system' || !String(history[0]?.content).includes(SUMMARY)) {
    throw new Error('restart did not restore persisted summary into OpenAI chat history')
  }
  if (history.length !== RECENT.length + 1) throw new Error(`restart restored unexpected history length: ${history.length}`)
  if (String(history.at(-1)?.content) !== String(RECENT.at(-1)?.content)) throw new Error('restart lost the newest retained message')
  console.log(JSON.stringify({ stage, sessionId: SESSION_ID, restored: true, historyLength: history.length, summaryRestored: true, emittedAfterRestore: emitted.length }))
}

void app // Keep the Electron import explicit so the bundle is exercised in main-process context.
