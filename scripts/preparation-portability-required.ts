import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionMeta } from '../src/shared/types'
import { PreparationPermissionStore } from '../src/main/permission/preparation-permission-store'
import { preparationPaths, purgePreparationData } from '../src/main/data-lifecycle/preparation-data-files'
import { assertProjectPreparationImportable, importProjectPreparation, validateProjectPreparation } from '../src/main/data-lifecycle/preparation-portability'
import { collectProjectSessionPortableSlice, importProjectSessionPortableSlice, verifyProjectSessionPortableSlice } from '../src/main/data-lifecycle/project-session-portability'
import { purgeProjectSessionData, purgeStandaloneSessionFiles, scanProjectSessionResiduals, scanStandaloneSessionResiduals } from '../src/main/data-lifecycle/project-session-purge'
import { ProjectDeletionBackupStore } from '../src/main/data-lifecycle/project-deletion-backup-store'
import { importProjectPortableRuntime } from '../src/main/data-lifecycle/project-portable-runtime'
import { importProjectAggregate } from '../src/main/data-lifecycle/project-import-coordinator'
import { hasVerifiedPreparationRestoreAfter } from '../src/main/data-lifecycle/preparation-restore-evidence'
import { SessionDeletionJournal, SESSION_DELETION_PHASES } from '../src/main/data-lifecycle/session-deletion-journal'
import { assertPreparationSessionNotDeleted } from '../src/main/permission/preparation-permission-lifecycle'
import { withDataLifecycleMutation } from '../src/main/data-lifecycle/data-lifecycle-mutation-lock'
import { createProductionProjectAggregateService } from '../src/main/project-aggregate/project-aggregate-factory'
import { projectAggregateDigest } from '../src/main/project-aggregate/codec'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { createProjectGoalTask, goalTaskIds } from '../src/main/project-workspace/goal-task-service'
import { historyStoreDocument } from '../src/main/history-store-format'

const roots: string[] = []
const root = () => { const value = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-prep-portable-'))); roots.push(value); return value }
const projectId = 'prep-portable', sessionId = randomUUID()
let passed = 0
async function check(name: string, run: () => void | Promise<void>) { await run(); passed++; console.log(`PASS ${name}`) }
function metaAt(directory: string): SessionMeta {
  const cwd = join(directory, 'formal'); mkdirSync(cwd, { recursive: true })
  return { id: sessionId, cwd, createdAt: 1, workspaceId: projectId, ...goalTaskIds(projectId, 'request-a'),
    status: 'idle', taskStrategy: 'plan' } as SessionMeta
}
async function main() {
  const source = root(), meta = metaAt(source), permissions = new PreparationPermissionStore(source)
  await (await openProjectWorkspaceStore(source)).createWorkspace({ id: projectId, name: 'Preparation fixture', kind: 'software' })
  await createProjectGoalTask({ projectId, requestId: 'request-a', objective: '准备客户汇报' }, source)
  writeFileSync(join(source, 'sessions.json'), JSON.stringify(historyStoreDocument([meta])))
  const grant = permissions.grant(meta, { expectedRevision: 0 }, 'local-user:test')
  const content = '客户汇报草稿与来源说明。', draft = join(grant.directory!, '客户汇报.md')
  writeFileSync(draft, content)
  const aggregateService = createProductionProjectAggregateService(source)
  await aggregateService.sealProject(projectId, { expectedAggregateRevision: 0 })
  const exported = await aggregateService.exportProject(projectId), runtime = exported.bundle.runtime!, slice = runtime.preparation!

  await check('ordinary Project export includes owned draft bytes and validated source permission audit', () => {
    assert.equal(slice.sessions.length, 1)
    const session = slice.sessions[0]
    assert.equal(session.sessionId, sessionId)
    assert.equal(session.files[0].path, '客户汇报.md')
    assert.equal(Buffer.from(session.files[0].data, 'base64').toString('utf8'), content)
    assert.equal(JSON.parse(session.permissionSource!).status, 'granted')
    assert.equal(JSON.parse(session.permissionSource!).revision, grant.revision)
  })
  const target = root(), targetMeta = metaAt(target)
  await check('backup restore writes revoked tombstone before drafts and requires explicit current-target grant', async () => {
    const backups = new ProjectDeletionBackupStore(source), receipt = backups.write('prep-delete', projectId, exported)
    const backup = backups.read(receipt.path, 'prep-delete', projectId)
    await withDataLifecycleMutation(target, () => importProjectPortableRuntime(backup.aggregateExport, target))
    const store = new PreparationPermissionStore(target), view = store.get(targetMeta)
    assert.equal(view.status, 'revoked'); assert.equal(view.available, false)
    assert.equal(view.revision, grant.revision + 1)
    assert.equal(readFileSync(join(view.directory!, '客户汇报.md'), 'utf8'), content)
    assert.throws(() => store.assertWritable(targetMeta, grant.revision, view.directory!), /撤销/)
    // Exact retry does not append another revocation or duplicate files.
    await withDataLifecycleMutation(target, () => importProjectPortableRuntime(backup.aggregateExport, target))
    assert.equal(store.get(targetMeta).revision, view.revision)
    const next = store.grant(targetMeta, { expectedRevision: view.revision }, 'local-user:new-explicit-grant')
    assert.equal(next.available, true); assert.equal(next.revision, view.revision + 1)
    assert(!JSON.parse(readFileSync(preparationPaths(target, sessionId).permission, 'utf8')).importedNeedsReauthorization)
    assert.throws(() => assertProjectPreparationImportable(target, projectId, slice, runtime), /permission conflict/)
    store.revoke(targetMeta, { expectedRevision: next.revision }, 'local-user:test')
    const revoked = readFileSync(preparationPaths(target, sessionId).permission, 'utf8')
    assert.throws(() => assertProjectPreparationImportable(target, projectId, slice, runtime), /permission conflict/)
    assert.equal(readFileSync(preparationPaths(target, sessionId).permission, 'utf8'), revoked)
  })
  await check('unsafe paths, wrong ownership, changed bytes and hidden credentials cannot enter the portable slice', () => {
    for (const mutate of [
      (value: typeof slice) => { value.sessions[0].files[0].path = '../outside.md' },
      (value: typeof slice) => { value.sessions[0].workspaceId = 'other-project' },
      (value: typeof slice) => { value.sessions[0].files[0].data = Buffer.from('changed').toString('base64') },
      (value: typeof slice) => { const bytes = Buffer.from(`Bearer ${'test'.repeat(12)}`); const file = value.sessions[0].files[0]
        file.data = bytes.toString('base64'); file.sizeBytes = bytes.length; file.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
    ]) {
      const value = structuredClone(slice); mutate(value)
      const { sliceDigest: _, ...body } = value; value.sliceDigest = projectAggregateDigest(body)
      assert.throws(() => validateProjectPreparation(projectId, value, runtime))
    }
    const unsafe = root(), external = root()
    symlinkSync(external, join(unsafe, 'preparation-drafts'))
    assert.throws(() => importProjectPreparation(unsafe, projectId, slice, runtime), /not regular/)
    assert(!existsSync(preparationPaths(unsafe, sessionId).permission))
  })
  await check('permanent Project and Session deletion remove original text, permission sources and audit copies', async () => {
    const unrelated = { ...meta, id: randomUUID(), workspaceId: 'unrelated-project' }
    const other = permissions.grant(unrelated, { expectedRevision: 0 }, 'local-user:test')
    writeFileSync(join(other.directory!, 'retain.md'), 'another task')
    await withDataLifecycleMutation(source, async () => { purgeProjectSessionData(source, projectId, [sessionId], []) })
    const counts = scanProjectSessionResiduals(source, projectId, [sessionId], [])
    assert.equal(counts.preparationDrafts, 0); assert.equal(counts.preparationPermissions, 0)
    assert(existsSync(join(other.directory!, 'retain.md')))
    await withDataLifecycleMutation(target, async () => { purgeStandaloneSessionFiles(target, sessionId, 'sdk-fixture') })
    const residual = scanStandaloneSessionResiduals(target, sessionId, 'sdk-fixture')
    assert.equal(residual.preparationDrafts, 0); assert.equal(residual.preparationPermissions, 0); assert.equal(residual.preparationImportAudits, 0)
    assert(!existsSync(preparationPaths(target, sessionId).drafts))
  })
  await check('a delayed lifecycle-locked writer cannot recreate preparation content after purge', async () => {
    const local = root(), currentMeta = metaAt(local), store = new PreparationPermissionStore(local)
    const authority = store.grant(currentMeta, { expectedRevision: 0 }, 'local-user:test')
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    const delayed = (async () => { await wait; return withDataLifecycleMutation(local, async () => {
      store.assertWritable(currentMeta, authority.revision, authority.directory!)
      mkdirSync(authority.directory!, { recursive: true }); writeFileSync(join(authority.directory!, 'late.md'), 'must not reappear')
    }) })()
    await withDataLifecycleMutation(local, async () => { purgePreparationData(local, [sessionId]) })
    release(); await assert.rejects(delayed, /撤销/)
    assert(!existsSync(preparationPaths(local, sessionId).drafts))
  })
  await check('legacy session slices without preparation remain readable', () => {
    const empty = root()
    const value = collectProjectSessionPortableSlice(empty, projectId, [])
    delete value.preparation
    importProjectSessionPortableSlice(empty, projectId, value)
    verifyProjectSessionPortableSlice(empty, projectId, value)
  })
  await check('completed local import supersedes an older deletion only for matching restored Session identity', async () => {
    const local = root(), currentMeta = { ...meta, cwd: metaAt(local).cwd }
    const journal = new SessionDeletionJournal(local)
    let deletion = await journal.begin(sessionId, 'original-sdk')
    for (const phase of SESSION_DELETION_PHASES.slice(1)) deletion = await journal.advance(deletion.operationId, phase)
    assert.throws(() => assertPreparationSessionNotDeleted(local, currentMeta), /已永久删除/)
    await importProjectAggregate(exported.bundle, local)
    assert(hasVerifiedPreparationRestoreAfter(local, currentMeta, deletion.completedAt!))
    assertPreparationSessionNotDeleted(local, currentMeta)
    assert(!hasVerifiedPreparationRestoreAfter(local, { ...currentMeta, goalId: 'foreign-goal' }, deletion.completedAt!))
    const restored = new PreparationPermissionStore(local), view = restored.get(currentMeta)
    assert.equal(view.available, false)
    assert.equal(restored.grant(currentMeta, { expectedRevision: view.revision }, 'local-user:restore').available, true)
    await journal.begin(sessionId, 'second-sdk')
    assert.throws(() => assertPreparationSessionNotDeleted(local, currentMeta), /正在删除/)
  })
  console.log(`preparation-portability: ${passed}/${passed} passed (temporary local data only)`)
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
  .finally(() => { for (const directory of roots) rmSync(directory, { recursive: true, force: true }) })
