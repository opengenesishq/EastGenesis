import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextPackPath, persistContextPack, restoreContextPack } from '../src/main/agent/context-pack-persistence'
import type { ChatMessage } from '../src/main/openAiEngineTypes'

const rootDir = mkdtempSync(join(tmpdir(), 'caogen-context-pack-'))
const reportPath = join(process.cwd(), 'test-results', 'context-pack-persistence', 'latest.json')
const sessionId = 'context-pack-persistence-fixture'
const recent: ChatMessage[] = [
  { role: 'user', content: '保留用户边界' },
  { role: 'assistant', content: '已保留。' }
]

try {
  const saved = persistContextPack(rootDir, sessionId, {
    sourceMessageCount: 12,
    boundarySeq: 8,
    summary: '早期目标、约束和已确认决定的脱敏摘要。',
    recent
  })
  const restored = restoreContextPack(rootDir, sessionId)
  assert(restored?.digest === saved.digest, 'restart must restore the same Context Pack digest')
  assert(restored?.recent.length === recent.length && restored.recent[0]?.content === recent[0]?.content, 'restart must restore recent messages')

  const filePath = contextPackPath(rootDir, sessionId)
  const tampered = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
  tampered.summary = 'tampered'
  writeFileSync(filePath, `${JSON.stringify(tampered)}\n`, 'utf8')
  assertThrows(() => restoreContextPack(rootDir, sessionId), 'tampered persisted Context Pack must be blocked')
  const report = { schemaVersion: 1, kind: 'caogen.context-pack-persistence-report', status: 'passed', checks: ['durable_write', 'restart_readback', 'tamper_block'], generatedAt: new Date().toISOString() }
  mkdirSync(join(process.cwd(), 'test-results', 'context-pack-persistence'), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`context pack persistence: PASS (durable write, restart readback, tamper block)\nreport: ${reportPath}`)
} finally {
  rmSync(rootDir, { recursive: true, force: true })
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertThrows(operation: () => unknown, message: string): void {
  try { operation() } catch { return }
  throw new Error(message)
}
