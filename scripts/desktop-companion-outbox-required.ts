import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopCompanionOutbox } from '../src/main/desktop-companion-outbox'
import { appendPersistentComposerDraft, readComposerDraft } from '../src/renderer/src/store/composer-draft-persistence'
import type { SessionMeta } from '../src/shared/types'

const root = mkdtempSync(join(tmpdir(), 'caogen-companion-outbox-'))
const file = join(root, 'outbox.json')
const meta = { id: 'fixture-session', createdAt: 1, status: 'idle', workspaceId: 'workspace', goalId: 'goal', workItemId: 'work' } as SessionMeta
const draft = { requestId: 'stable-request', sessionId: meta.id, text: '第二页补来源' }
const values = new Map<string, string>()
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size }, clear: () => values.clear() } as Storage
try {
  const initial = new DesktopCompanionOutbox(file)
  assert.equal(initial.enqueue(draft, meta).status, 'pending')
  const restored = new DesktopCompanionOutbox(file)
  const delivery = restored.pending(() => meta)[0]
  assert.equal(delivery.text, draft.text)
  assert.equal(restored.enqueue(draft, meta).requestId, draft.requestId)
  assert.throws(() => restored.enqueue({ ...draft, text: '其他内容' }, meta), /其他内容/)
  assert.throws(() => restored.enqueue(draft, { ...meta, workItemId: 'other' }), /其他内容/)
  appendPersistentComposerDraft(storage, meta.id, delivery.text, delivery.requestId)
  // Receiver persisted but the process died before acknowledgement: retransmit only once.
  assert.equal(appendPersistentComposerDraft(storage, meta.id, delivery.text, delivery.requestId).duplicate, true)
  assert.equal(readComposerDraft(storage, meta.id), draft.text)
  restored.acknowledge({ ...delivery, status: 'delivered' })
  assert.deepEqual(restored.pending(() => meta), [])
  assert.equal(new DesktopCompanionOutbox(file).enqueue(draft, meta).status, 'delivered')
  assert.equal(readFileSync(file, 'utf8').includes(draft.text), false)
  assert.throws(() => restored.acknowledge({ ...delivery, text: 'wrong', status: 'delivered' }), /不匹配/)
  for (const [index, changed] of [undefined, { ...meta, status: 'closed' }, { ...meta, goalId: 'other' }].entries()) {
    restored.enqueue({ ...draft, requestId: `stale-${index}` }, meta)
    assert.deepEqual(restored.pending(() => changed as SessionMeta | undefined), [])
    assert.equal(restored.receipts().at(-1)?.status, 'rejected')
  }
  const unavailableStorage = { ...storage, setItem: () => { throw new Error('disk-full') } } as Storage
  assert.throws(() => appendPersistentComposerDraft(unavailableStorage, meta.id, '未持久化', 'disk-failure'), /disk-full/)
  restored.purge([meta.id])
  assert.deepEqual(restored.receipts(), [])
  writeFileSync(file, '{"version":1,"items":[{}]}')
  assert.throws(() => restored.enqueue(draft, meta), /损坏/)
  console.log('PASS: companion durable queue, restart/retry, ownership/close rejection, acknowledgement validation, exactly-once draft append, storage failure and deletion.')
} finally { rmSync(root, { recursive: true, force: true }) }
