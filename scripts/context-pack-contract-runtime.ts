import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { assertPortableTextBoundary, validateRuntimeContinuationContext } from '../src/main/session-runtime-continuation-context'
import { buildProviderNeutralContextDigest } from '../src/main/task/provider-neutral-context'
import { evaluateContextUsage, planCompressionBoundary, type ContextMessage } from '../src/main/agent/context-compressor'
import type { SessionMeta, TranscriptEntry } from '../src/shared/types'

const outputDir = join(process.cwd(), 'test-results', 'context-pack-contract')
const reportPath = join(outputDir, 'latest.json')

run()

function run(): void {
  const entries: TranscriptEntry[] = [
    { seq: 1, event: { kind: 'user-message', text: '确认产品发布目标', messageId: 'fixture-context-user-1' } },
    { seq: 2, event: { kind: 'assistant-message', blocks: [{ type: 'text', text: '目标已确认。' }] } },
    { seq: 3, event: { kind: 'user-message', text: '整理交付边界', messageId: 'fixture-context-user-2' } },
    { seq: 4, event: { kind: 'assistant-message', blocks: [{ type: 'text', text: '边界已整理。' }] } },
    { seq: 5, event: { kind: 'turn-result', subtype: 'success', isError: false, resultText: '完成' } }
  ]
  const replay = assertPortableTextBoundary(entries)
  const contextDigest = buildProviderNeutralContextDigest({ entries })
  const meta = {
    id: 'fixture-context-session',
    engine: 'anthropic',
    runtimeContinuation: {
      schemaVersion: 1,
      id: 'fixture-context-continuation',
      state: 'committed',
      fromEngine: 'openai',
      toEngine: 'anthropic',
      providerId: 'fixture-provider',
      model: 'fixture-model',
      boundarySeq: 5,
      contextDigest,
      createdAt: Date.now()
    }
  } as unknown as SessionMeta
  validateRuntimeContinuationContext(meta, entries)
  const tampered = structuredClone(meta)
  tampered.runtimeContinuation!.contextDigest = `sha256:${'0'.repeat(64)}`
  assertThrows(() => validateRuntimeContinuationContext(tampered, entries), 'tampered context digest must be blocked')

  const messages: ContextMessage[] = Array.from({ length: 16 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `context ${index} `.repeat(120)
  }))
  const usage = evaluateContextUsage({ usedTokens: 9_200, model: 'fixture-model', contextWindowTokens: 10_000 })
  const boundary = planCompressionBoundary(messages, 4)
  assert(usage.shouldCompress && usage.pressure === 'critical', 'compression threshold must be critical')
  assert(boundary.canCompress && boundary.recentCount === 4 && boundary.keepFrom > 1, 'compression must keep a user boundary')

  const report = {
    schemaVersion: 1,
    kind: 'caogen.context-pack-contract-report',
    status: 'passed',
    replay: { eventCount: replay.eventCount, attachmentCount: replay.attachmentCount, characters: replay.characters },
    continuation: { state: meta.runtimeContinuation?.state, boundarySeq: meta.runtimeContinuation?.boundarySeq, contextDigest },
    compression: { pressure: usage.pressure, usageRatio: usage.usageRatio, keepFrom: boundary.keepFrom, recentCount: boundary.recentCount },
    checks: ['portable_text_boundary', 'committed_continuation_digest', 'tamper_blocked', 'compression_boundary']
  }
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
}

function assertThrows(operation: () => void, message: string): void {
  try {
    operation()
  } catch {
    return
  }
  throw new Error(message)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
