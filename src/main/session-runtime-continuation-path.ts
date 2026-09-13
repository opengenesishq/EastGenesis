import { createHash } from 'node:crypto'
import { join } from 'node:path'

export function runtimeContinuationReceiptPath(rootDir: string, sessionId: string): string {
  return join(rootDir, 'runtime-continuations', `${createHash('sha256').update(sessionId).digest('hex')}.json`)
}
