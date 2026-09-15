import { homedir } from 'node:os'
import { resolve } from 'node:path'

/** The running app's profile owns memory; fallback paths serve standalone callers. */
export function resolveMemoryRoot(userDataRoot?: string): string {
  if (userDataRoot?.trim()) return resolve(userDataRoot, 'memory')
  if (process.env.CAOGEN_USER_DATA_DIR?.trim()) return resolve(process.env.CAOGEN_USER_DATA_DIR, 'memory')
  return process.env.CAOGEN_MEMORY_DIR || resolve(homedir(), '.caogen', 'memory')
}
