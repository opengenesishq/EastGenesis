import { createHash } from 'node:crypto'
import { stableValueDigest } from '../task/tool-idempotency'
export function officeBytesDigest(value: string | Uint8Array): string { return `sha256:${createHash('sha256').update(value).digest('hex')}` }
export function officeValueDigest(value: unknown): string { return `sha256:${stableValueDigest(value)}` }
