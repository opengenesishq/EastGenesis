import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { resolveWorkspaceSessionCwd } from '../src/main/project-workspace/workspace-session-cwd'

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'caogen-primary-folder-'))
  const a = join(root, 'a'), b = join(root, 'b')
  mkdirSync(a); mkdirSync(b)
  try {
    const store = await openProjectWorkspaceStore(root)
    let workspace = await store.createWorkspace({ name: 'Primary folder fixture', resources: [
      { id: 'a', kind: 'directory', path: a }, { id: 'b', kind: 'repository', path: b }
    ] })
    const existingTaskDirectory = await resolveWorkspaceSessionCwd(workspace.id, root)
    assert.equal(existingTaskDirectory, a)
    workspace = await store.updateWorkspace(workspace.id, { primaryResourceId: 'b' }, { expectedRevision: workspace.revision })
    assert.equal(await resolveWorkspaceSessionCwd(workspace.id, root), b)
    assert.equal((await (await openProjectWorkspaceStore(root)).getWorkspace(workspace.id))?.primaryResourceId, 'b')
    assert.equal((await store.exportManifest(workspace.id)).workspace.primaryResourceId, 'b')
    assert.equal(existingTaskDirectory, a)
    console.log('PASS: real workspace persistence, export and new task cwd select the explicit folder')
    await assert.rejects(store.updateWorkspace(workspace.id, { primaryResourceId: 'missing' }, { expectedRevision: workspace.revision }))
    await assert.rejects(store.updateWorkspace(workspace.id, { resources: [workspace.resources[0]] }, { expectedRevision: workspace.revision }))
    await assert.rejects(store.updateWorkspace(workspace.id, { primaryResourceId: 'a' }, { expectedRevision: workspace.revision - 1 }))
    assert.equal((await store.getWorkspace(workspace.id))?.revision, workspace.revision)
    rmSync(b, { recursive: true })
    await assert.rejects(resolveWorkspaceSessionCwd(workspace.id, root), /主文件夹不存在/)
    console.log('PASS: invalid selection, stale update and missing explicit folder cannot silently change cwd')
    workspace = await store.updateWorkspace(workspace.id, { resources: [workspace.resources[0]], primaryResourceId: null }, { expectedRevision: workspace.revision })
    assert.equal(workspace.primaryResourceId, undefined)
    assert.equal(await resolveWorkspaceSessionCwd(workspace.id, root), a)
    console.log('PASS: explicit reset or removing primary with reset restores legacy directory selection')
  } finally { rmSync(root, { recursive: true, force: true }) }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
