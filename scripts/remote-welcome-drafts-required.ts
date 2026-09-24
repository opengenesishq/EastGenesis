import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RemoteWelcomeDraftStore, assertRemoteWelcomeDraftHost } from '../src/main/task-window-drafts'
import type { RemoteWelcomeDraftInput } from '../src/shared/task-window-types'
import type { RemoteHostView } from '../src/shared/remote-host-types'

const root = mkdtempSync(join(tmpdir(), 'caogen-remote-welcome-drafts-')), file = join(root, 'drafts.json')
const input: RemoteWelcomeDraftInput = { requestId: 'original-request', text: 'Continue the report', hostId: 'host-1',
  expectedConnection: { projectId: 'project:remote', deviceId: 'device-1', origin: 'https://example.invalid', spkiFingerprint: `sha256:${'a'.repeat(64)}` } }
try {
  const store = new RemoteWelcomeDraftStore(file)
  assert.equal(store.enqueue(input, 'source-task').status, 'pending')
  assert.equal(store.enqueue(input, 'source-task').status, 'pending')
  const restarted = new RemoteWelcomeDraftStore(file)
  assert.equal(restarted.pending().length, 1)
  assert.equal(restarted.pending()[0].text, input.text)
  assert.throws(() => restarted.enqueue({ ...input, text: 'Different text' }, 'source-task'), /标识/)
  assert.throws(() => restarted.enqueue(input, 'different-task'), /标识/)
  assert.throws(() => restarted.enqueue({ ...input, expectedConnection: { ...input.expectedConnection, deviceId: 'different-device' } }, 'source-task'), /标识/)
  console.log('PASS durable original draft; duplicate request and source/target/text binding')
  restarted.acknowledge(input.requestId); restarted.acknowledge(input.requestId)
  assert.deepEqual(restarted.pending(), [])
  assert.equal(restarted.enqueue(input, 'source-task').status, 'delivered')
  assert.ok(!readFileSync(file, 'utf8').includes(input.text))
  console.log('PASS acknowledgment persists only receipt; resend does not reinsert draft')
  const host = { id: input.hostId, projectId: input.expectedConnection.projectId, deviceId: input.expectedConnection.deviceId,
    identity: { origin: input.expectedConnection.origin, spkiFingerprint: input.expectedConnection.spkiFingerprint }, status: 'expired' } as RemoteHostView
  assertRemoteWelcomeDraftHost(input, host)
  assert.throws(() => assertRemoteWelcomeDraftHost(input, { ...host, status: 'revoked' }))
  assert.throws(() => assertRemoteWelcomeDraftHost(input, { ...host, projectId: 'other-project' }))
  assert.throws(() => assertRemoteWelcomeDraftHost(input, { ...host, identity: { ...host.identity, spkiFingerprint: `sha256:${'b'.repeat(64)}` } }))
  store.enqueue({ ...input, requestId: 'second' }, 'source-task')
  const corrupt = JSON.parse(readFileSync(file, 'utf8')); corrupt.items[1].draft.text = 'mutated'; writeFileSync(file, JSON.stringify(corrupt))
  assert.throws(() => store.pending(), /核对/)
  console.log('PASS revoked/replaced host and corrupted pending text are rejected')
  console.log(JSON.stringify({ passed: 3, externalRequests: 0 }))
} finally { rmSync(root, { recursive: true, force: true }) }
