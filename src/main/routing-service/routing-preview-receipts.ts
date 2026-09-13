import { randomUUID } from 'node:crypto'
import type { RoutingPreviewContext, RoutingPreviewReceipt } from '../../shared/routing-policy-types'
import { canonicalRoutingJson, routingSettingsDigest } from '../routing-settings/routing-settings-json'

interface ReceiptEntry { receipt: RoutingPreviewReceipt; context: RoutingPreviewContext; expiresAt: number }
const RECEIPT_LIFETIME_MS = 5 * 60_000
const RECEIPT_LIMIT = 64

/** Bounded, expiring main-issued receipts. A caller-computed digest is insufficient. */
export function createRoutingPreviewReceipts(now = Date.now) {
  const entries = new Map<string, ReceiptEntry>()
  function prune(): void {
    for (const [key, entry] of entries) if (entry.expiresAt <= now()) entries.delete(key)
    while (entries.size >= RECEIPT_LIMIT) entries.delete(entries.keys().next().value!)
  }
  function issue(body: Omit<RoutingPreviewReceipt, 'previewDigest'>, context: RoutingPreviewContext): RoutingPreviewReceipt {
    prune()
    const receipt = { ...body, previewDigest: routingSettingsDigest({ ...body, nonce: randomUUID() }) }
    entries.set(receipt.previewDigest, { receipt, context: structuredClone(context), expiresAt: now() + RECEIPT_LIFETIME_MS })
    return { ...receipt }
  }
  function read(receipt: RoutingPreviewReceipt): RoutingPreviewContext | undefined {
    const entry = entries.get(receipt.previewDigest)
    if (!entry || entry.expiresAt <= now()) { entries.delete(receipt.previewDigest); return undefined }
    if (canonicalRoutingJson(entry.receipt) !== canonicalRoutingJson(receipt)) return undefined
    return structuredClone(entry.context)
  }
  return { issue, read }
}
