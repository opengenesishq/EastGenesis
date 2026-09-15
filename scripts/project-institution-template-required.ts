import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { projectWorkspaceFile } from '../src/main/project-workspace/persistence'
import {
  DEFAULT_PROJECT_INSTITUTION_TEMPLATE,
  LEGACY_PROJECT_INSTITUTION_TEMPLATE,
  previewProjectInstitutionMigration,
  projectInstitutionTemplate,
  type ProjectInstitutionTemplateRef
} from '../src/shared/project-institution-template'

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'caogen-institutions-'))
  try {
    const store = await new ProjectWorkspaceStore(root).open()
    const current = await store.createWorkspace({ name: 'New default project' })
    assert.deepEqual(current.institutionTemplate, DEFAULT_PROJECT_INSTITUTION_TEMPLATE)
    const firstReload = await new ProjectWorkspaceStore(root).open()
    assert.deepEqual((await firstReload.getWorkspace(current.id))?.institutionTemplate, DEFAULT_PROJECT_INSTITUTION_TEMPLATE)
    const manifest = await store.exportManifest(current.id)
    assert.deepEqual(manifest.workspace.institutionTemplate, DEFAULT_PROJECT_INSTITUTION_TEMPLATE)
    assert.equal(projectInstitutionTemplate(current.institutionTemplate).roles[0].id, 'huangdi')
    assert.equal(projectInstitutionTemplate(current.institutionTemplate).roles.some((role) => role.id === 'taizi'), false)
    assert.equal(projectInstitutionTemplate(current.institutionTemplate).roles.some((role) => role.id === 'xichang'), false)

    const legacy = await store.createWorkspace({
      name: 'Legacy project', institutionTemplate: LEGACY_PROJECT_INSTITUTION_TEMPLATE,
      permissionPolicy: { allowedRoleIds: ['taizi', 'xichang', 'libu'], customRoleId: 'my-original-role' }
    })
    await store.createGoal({ projectId: legacy.id, title: 'Existing work', objective: 'Preserve original work' })
    // Model an on-disk pre-template project. Reads and unrelated edits must not backfill it.
    const file = projectWorkspaceFile(root)
    const state = JSON.parse(await readFile(file, 'utf8'))
    const storedLegacy = state.workspaces.find((workspace: { id: string }) => workspace.id === legacy.id)
    delete storedLegacy.institutionTemplate
    await writeFile(file, JSON.stringify(state), 'utf8')
    const beforeRead = await readFile(file, 'utf8')
    const reopened = await new ProjectWorkspaceStore(root).open()
    const old = (await reopened.getWorkspace(legacy.id))!
    assert.equal(old.institutionTemplate, undefined)
    assert.equal(projectInstitutionTemplate(old.institutionTemplate).ref.templateId, 'legacy-compatible')
    assert.equal(await readFile(file, 'utf8'), beforeRead)
    const oldGoals = await reopened.listGoals(legacy.id)
    const preview = previewProjectInstitutionMigration({ institutionTemplate: old.institutionTemplate, target: DEFAULT_PROJECT_INSTITUTION_TEMPLATE, workItems: [{ status: 'running' }, { status: 'done' }] })
    assert.deepEqual(preview.legacyOnly.map((role) => role.id), ['taizi', 'xichang'])
    assert.equal(preview.pendingWorkCount, 1)
    assert.equal(preview.recordedWorkCount, 2)
    assert.ok(preview.retained.some((role) => role.id === 'libu'))
    assert.ok(preview.retained.some((role) => role.id === 'libu_ritual'))
    assert.equal(await readFile(file, 'utf8'), beforeRead)
    await assert.rejects(reopened.updateWorkspace(old.id, { institutionTemplate: DEFAULT_PROJECT_INSTITUTION_TEMPLATE }, { expectedRevision: old.revision }), /已有任务/)
    assert.equal(await readFile(file, 'utf8'), beforeRead)
    const renamed = await reopened.updateWorkspace(old.id, { name: 'Same legacy identities' }, { expectedRevision: old.revision })
    assert.equal(renamed.institutionTemplate, undefined)
    assert.deepEqual(renamed.permissionPolicy, old.permissionPolicy)
    assert.deepEqual(await reopened.listGoals(old.id), oldGoals)
    const imported = await new ProjectWorkspaceStore(join(root, 'imported')).open()
    const legacyManifest = await reopened.exportManifest(old.id)
    await imported.importProjectSlice(legacyManifest)
    assert.deepEqual(await imported.getWorkspace(old.id), renamed)
    const beforeInvalidImport = await readFile(imported.filePath, 'utf8')
    await assert.rejects(imported.importProjectSlice({ ...legacyManifest, workspace: {
      ...legacyManifest.workspace,
      institutionTemplate: { ...DEFAULT_PROJECT_INSTITUTION_TEMPLATE, templateVersion: 99 } as unknown as ProjectInstitutionTemplateRef
    } }), /invalid/)
    assert.equal(await readFile(imported.filePath, 'utf8'), beforeInvalidImport)

    const empty = await reopened.createWorkspace({ name: 'Empty legacy project', institutionTemplate: LEGACY_PROJECT_INSTITUTION_TEMPLATE })
    const changed = await reopened.updateWorkspace(empty.id, { institutionTemplate: DEFAULT_PROJECT_INSTITUTION_TEMPLATE }, { expectedRevision: empty.revision })
    assert.deepEqual(changed.institutionTemplate, DEFAULT_PROJECT_INSTITUTION_TEMPLATE)
    assert.equal(changed.revision, empty.revision + 1)
    await assert.rejects(reopened.updateWorkspace(empty.id, { institutionTemplate: LEGACY_PROJECT_INSTITUTION_TEMPLATE }, { expectedRevision: empty.revision }), /revision/)
    for (const invalid of [null, { ...DEFAULT_PROJECT_INSTITUTION_TEMPLATE, templateVersion: 99 }, { ...DEFAULT_PROJECT_INSTITUTION_TEMPLATE, permissions: ['all'] }]) {
      await assert.rejects(reopened.createWorkspace({ name: 'Invalid', institutionTemplate: invalid as unknown as ProjectInstitutionTemplateRef }), /invalid/)
    }
    console.log('Project institution defaults, persistence, legacy read/import, migration preview, history protection and revision checks passed.')
  } finally { await rm(root, { recursive: true, force: true }) }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
