import type { SendMessagePayload } from '../shared/message-payload-types'
import { stableValueDigest } from './task/tool-idempotency'

/** Bind the original user request, including document versions and typed intent, to its ledger event. */
export function messagePayloadDigest(payload: SendMessagePayload): string {
  return stableValueDigest({ text: payload.text.trim(), images: payload.images ?? [],
    documents: payload.documents ?? [], officeRevisionIntent: payload.officeRevisionIntent ?? null,
    ...(payload.goalRevisionIntent ? { goalRevisionIntent: payload.goalRevisionIntent } : {}),
    ...(payload.requirementRevisionIntent ? { requirementRevisionIntent: payload.requirementRevisionIntent } : {}) })
}
