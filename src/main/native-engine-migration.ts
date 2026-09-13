import type { EngineKind } from '../shared/types'

/** Normalize persisted legacy engine metadata at every read boundary. */
export function migrateLegacyEngineRecord<T extends { engine?: string }>(record: T): T {
  return record.engine === 'claude' ? { ...record, engine: 'anthropic' as EngineKind } : record
}
