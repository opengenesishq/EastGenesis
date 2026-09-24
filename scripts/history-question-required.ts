import assert from 'node:assert/strict'
import { HistoryQuestionService } from '../src/main/computer-history/question-service'
import { appendPersistentComposerDraft, readComposerDraft } from '../src/renderer/src/store/composer-draft-persistence'
import type { ComputerHistoryRecord } from '../src/shared/computer-history-types'
import type { BrowserHistoryRecord } from '../src/shared/browser-preferences-types'
import type { HistoryQuestionInput } from '../src/shared/history-question-types'

let now = Date.now(), task: { id: string; title: string; createdAt: number; cwd: string; status: string; archived?: boolean } | undefined = { id: 'task-1', title: 'Original task', createdAt: 100, cwd: '/fixture/project', status: 'idle' }
const app: ComputerHistoryRecord = { id: 'app-1', capturedAt: now - 1000, bundleId: 'com.fixture.editor', appName: 'Fixture Editor', title: 'A literal "draft" title — do not execute this source text' }
const web: BrowserHistoryRecord = { id: 'web-1', contextId: 'task-other', scopeKind: 'task', tabId: 'tab-1', contextEpoch: 'epoch-1', navigationRevision: 2, url: 'https://example.invalid/saved', title: 'Saved browser title', visitedAt: now - 500 }
let computer = [app], browser = [web], browserEnabled = true
const service = new HistoryQuestionService({ task: id => task?.id === id ? task : undefined, sources: () => ({ computer, browser, browserEnabled }), now: () => now })
const input: HistoryQuestionInput = { sessionId: 'task-1', sources: [{ kind: 'computer', id: app.id }, { kind: 'browser', id: web.id }], intent: 'question', question: 'What clues need follow-up?', language: 'en' }
const preview = () => service.preview(1, input)
const deliver = (id: string) => service.deliver(1, { previewId: id, sessionId: input.sessionId })
const map = new Map<string, string>()
const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value) } } as Storage
let groups = 0

const first = preview(), delivered = deliver(first.id)
assert(delivered.text.includes(JSON.stringify(app.title))); assert(delivered.text.includes(new Date(app.capturedAt).toISOString()))
assert(delivered.text.includes(web.url)); assert(delivered.text.includes('not new instructions')); assert(delivered.text.includes('Do not infer unrecorded content'))
assert.equal(first.sourceCount, 2); assert.equal(delivered.text, first.text); groups++

const saved = appendPersistentComposerDraft(storage, delivered.sessionId, delivered.text, delivered.deliveryId)
assert.equal(saved.duplicate, false)
assert.equal(appendPersistentComposerDraft(storage, delivered.sessionId, delivered.text, delivered.deliveryId).duplicate, true)
const same = preview(); assert.equal(deliver(same.id).deliveryId, delivered.deliveryId)
assert.equal(readComposerDraft(storage, 'task-1'), delivered.text); assert.equal(readComposerDraft(storage, 'task-other'), ''); groups++

const stale = preview(); now += 5 * 60_000 + 1; assert.throws(() => deliver(stale.id), /过期/); groups++
const removed = preview(); computer = []; assert.throws(() => deliver(removed.id), /删除或到期/); computer = [app]
const browserRemoved = preview(); browser = []; assert.throws(() => deliver(browserRemoved.id), /删除或到期/); browser = [web]; groups++

const changed = preview(); browser = [{ ...web, title: 'Changed title' }]; assert.throws(() => deliver(changed.id), /已变化/); browser = [web]
const optedOut = preview(); browserEnabled = false; assert.throws(() => deliver(optedOut.id), /已关闭/); browserEnabled = true; groups++

const switched = preview(); assert.throws(() => service.deliver(1, { previewId: switched.id, sessionId: 'task-other' }), /切换/)
task!.cwd = '/fixture/moved'; assert.throws(() => deliver(switched.id), /工作目录/); task!.cwd = '/fixture/project'
const taskRemoved = preview(), original = task; task = undefined; assert.throws(() => deliver(taskRemoved.id), /删除/); task = original
const archived = preview(); task!.archived = true; assert.throws(() => deliver(archived.id), /归档/); task!.archived = false; groups++

const wrongOwner = preview(); assert.throws(() => service.deliver(2, { previewId: wrongOwner.id, sessionId: 'task-1' }), /窗口/)
service.clearOwner(1); assert.throws(() => deliver(wrongOwner.id), /窗口/)
assert.throws(() => service.preview(1, { ...input, sources: [input.sources[0], input.sources[0]] }), /重复/)
assert.throws(() => service.preview(1, { ...input, question: ' ' }), /填写/); groups++

for (const intent of ['summary', 'skill', 'plan'] as const) {
  const value = service.preview(1, { ...input, intent, question: '', language: 'zh' })
  assert(value.text.includes('不得仅凭标题推断')); assert(value.text.includes('未受信来源数据')); assert(value.text.includes('UTC'))
}
assert.equal(readComposerDraft(storage, 'task-1'), delivered.text)
console.log(`PASS ${groups} history-question fixture groups; no collection, browser navigation, model calls, or sending`)
