import { app } from 'electron'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableFileSync } from '../durable-file'
import type { ModelAttemptRecord } from '../../shared/model-attempt-types'

export interface VoiceInputUsageRecord {
  id: string
  providerId: string
  model: string
  keyLabel?: string
  startedAt: number
  completedAt?: number
  durationMs: number
  audioBytes: number
  status: 'started' | 'succeeded' | 'failed' | 'cancelled'
}

function file(): string { return join(app.getPath('userData'), 'private', 'voice-input-usage.json') }
function records(): VoiceInputUsageRecord[] {
  if (!existsSync(file())) return []
  const info = lstatSync(file())
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error('语音用量记录无效。')
  const value = JSON.parse(readFileSync(file(), 'utf8')) as { schemaVersion?: number; records?: VoiceInputUsageRecord[] }
  if (value.schemaVersion !== 1 || !Array.isArray(value.records)) throw new Error('语音用量记录无效。')
  return value.records.filter((row) => typeof row.id === 'string' && typeof row.providerId === 'string' && typeof row.model === 'string'
    && Number.isFinite(row.startedAt) && ['started', 'succeeded', 'failed', 'cancelled'].includes(row.status))
}
export function saveVoiceInputUsage(record: VoiceInputUsageRecord): void {
  const next = [...records().filter((row) => row.id !== record.id), record].sort((a, b) => a.startedAt - b.startedAt).slice(-10_000)
  writeDurableFileSync(file(), JSON.stringify({ schemaVersion: 1, records: next }))
}
export function readVoiceInputUsageAttempts(): ModelAttemptRecord[] {
  return records().map((row) => ({
    schemaVersion: 1, id: row.id, requestId: row.id, runId: 'voice-input', workItemId: 'voice-input', ordinal: 0,
    providerId: row.providerId, model: row.model, keyLabel: row.keyLabel, protocol: 'audio.transcription', adapterVersion: 'voice-input-v1',
    contextDigest: 'sha256:voice-content-not-persisted', routeReason: 'Explicit user voice input transcription', status: row.status,
    revision: row.completedAt ? 2 : 1, startedAt: row.startedAt, completedAt: row.completedAt,
    latencyMs: row.completedAt === undefined ? undefined : row.completedAt - row.startedAt,
    outcome: row.status === 'succeeded' ? 'success' : row.status === 'cancelled' ? 'cancelled' : 'unknown',
    startCommandId: `voice:start:${row.id}`, startPayloadDigest: 'sha256:voice-content-not-persisted',
    completionCommandId: row.completedAt ? `voice:complete:${row.id}` : undefined,
    recordDigest: 'sha256:voice-usage-only-no-content'
    // No text, audio, keys, URLs or invented token/cost figures are persisted.
  }))
}
