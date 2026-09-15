import assert from 'node:assert/strict'
import { clearDeletedTaskLocalData } from '../src/renderer/src/store/task-local-data-cleanup'
import { readComposerDraft, writeComposerDraft } from '../src/renderer/src/store/composer-draft-persistence'

class MemoryStorage implements Storage {
  data = new Map<string, string>()
  get length() { return this.data.size }
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.data.set(key, value) }
  removeItem(key: string) { this.data.delete(key) }
  clear() { this.data.clear() }
  key(index: number) { return [...this.data.keys()][index] ?? null }
}

const storage = new MemoryStorage()
const journal = 'caogen.project-goal-submissions.v1'
for (const id of ['deleted-session', 'other-session', 'goal-intake:deleted-project', 'goal-intake:other-project']) {
  writeComposerDraft(storage, id, `${id} text`)
}
storage.setItem('caogen.session-input-request.v1:deleted-session', 'private deleted text')
storage.setItem('caogen.session-input-request.v1:other-session', 'other task text')
storage.setItem(journal, JSON.stringify([
  { projectId: 'deleted-project', requestId: 'before-session', objective: 'unconfirmed text' },
  { projectId: 'other-project', sessionId: 'other-session', objective: 'keep this text' }
]))
clearDeletedTaskLocalData(['deleted-session'], 'deleted-project', storage)
assert.equal(readComposerDraft(storage, 'deleted-session'), '')
assert.equal(readComposerDraft(storage, 'goal-intake:deleted-project'), '')
assert.equal(storage.getItem('caogen.session-input-request.v1:deleted-session'), null)
assert.equal(readComposerDraft(storage, 'other-session'), 'other-session text')
assert.equal(readComposerDraft(storage, 'goal-intake:other-project'), 'goal-intake:other-project text')
assert.equal(storage.getItem('caogen.session-input-request.v1:other-session'), 'other task text')
assert.equal(JSON.parse(storage.getItem(journal)!)[0].objective, 'keep this text')
assert.equal(JSON.parse(storage.getItem(journal)!).length, 1)
// An old mounted composer cannot write the deleted draft back after IPC resolves.
writeComposerDraft(storage, 'deleted-session', 'late response text')
assert.equal(JSON.parse(storage.getItem('caogen.composer-drafts.v1')!).drafts['deleted-session'], undefined)
// History deletion removes only its bound request; other project drafts remain.
clearDeletedTaskLocalData(['other-session'], undefined, storage)
assert.equal(storage.getItem(journal), null)
assert.equal(readComposerDraft(storage, 'goal-intake:other-project'), 'goal-intake:other-project text')
// Do not discard unrelated data if its containing document is malformed.
storage.setItem('caogen.composer-drafts.v1', '{broken')
assert.throws(() => clearDeletedTaskLocalData(['absent-session'], undefined, storage))
assert.equal(storage.getItem('caogen.composer-drafts.v1'), '{broken')
console.log('task local data cleanup: passed (targeted deletion, unrelated data, late writes, corrupt storage)')
