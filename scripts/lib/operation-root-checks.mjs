import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Keep app userData, the standalone store fallback, and an explicit caller root
// distinct. Matching canonical IDs in each root detect silent cross-store writes.
export async function runOperationRootChecks({
  tempRoot, outDir, gateway, snapshotStore, worktrees, worktreeHandlers, git, initRepo
}) {
  const projectApi = await import(pathToFileURL(path.join(outDir, 'main/project-workspace/store.js')).href)
  const commandApi = await import(pathToFileURL(path.join(outDir, 'main/project-workspace/command-service.js')).href)
  const previousLegacyRoot = process.env.CAOGEN_USER_DATA
  const previousAppRoot = process.env.CAOGEN_TEST_USER_DATA
  // Earlier gateway cases intentionally corrupt ledger snapshots. Give these
  // canonical-write checks their own application root instead of weakening it.
  const userData = path.join(tempRoot, 'operation-default-app-root')
  const legacyRoot = path.join(tempRoot, 'operation-unrelated-legacy-root')
  const explicitRoot = path.join(tempRoot, 'operation-explicit-root')
  process.env.CAOGEN_USER_DATA = legacyRoot
  process.env.CAOGEN_TEST_USER_DATA = userData
  try {
    const ownership = {
      workspaceId: 'operation-root-workspace',
      goalId: 'operation-root-goal',
      workItemId: 'operation-root-task'
    }
    const roots = [userData, explicitRoot, legacyRoot]
    const stores = await Promise.all(roots.map(async (root) => {
      const store = await projectApi.openProjectWorkspaceStore(root)
      await store.createWorkspace({ id: ownership.workspaceId, name: 'Operation root', kind: 'software' })
      const commands = commandApi.createProjectWorkspaceCommandService(store, { rootDir: root })
      await commands.createGoal({
        id: ownership.goalId, projectId: ownership.workspaceId, title: 'Root ownership',
        objective: 'Keep operation Runs and canonical ownership in the same data root'
      })
      await commands.createWorkItem({
        id: ownership.workItemId, projectId: ownership.workspaceId, goalId: ownership.goalId, title: 'Root operation'
      })
      return store
    }))
    for (const [label, expectedRoot, rootDir] of [
      ['default', userData, undefined],
      ['explicit', explicitRoot, explicitRoot]
    ]) {
      const before = await Promise.all(stores.map((store) => store.getRevision()))
      const cwd = path.join(tempRoot, `operation-${label}-files`)
      mkdirSync(cwd)
      const content = `${label} application root\n`
      const operationId = `root-${label}-file-write`
      let callbackCount = 0
      const result = await gateway.executeInteractiveOperationEffect({
        ...(rootDir === undefined ? {} : { rootDir }),
        operationId, ...ownership,
        kind: 'file_write', title: 'Root ownership regression', sourceSessionId: `root-${label}-session`,
        cwd, toolName: 'write_file', toolInput: { path: 'result.txt', content },
        execute: async (effect) => {
          callbackCount += 1
          const snapshot = await snapshotStore.getTaskSnapshot(effect.sessionId, expectedRoot)
          assert.equal(snapshot?.run?.effects?.find((item) => item.id === effect.id)?.status, 'executing')
          assert.equal(snapshot.meta.workItemId, ownership.workItemId)
          for (const otherRoot of roots.filter((root) => root !== expectedRoot)) {
            assert.equal(await snapshotStore.getTaskSnapshot(effect.sessionId, otherRoot), null)
          }
          writeFileSync(path.join(cwd, 'result.txt'), content)
          return { ok: true }
        },
        isSuccess: (value) => value.ok
      })
      assert.equal(result.status, 'completed', JSON.stringify(result))
      assert.equal(callbackCount, 1)
      assert.equal(readFileSync(path.join(cwd, 'result.txt'), 'utf8'), content)
      await assertRootBinding({ roots, stores, before, expectedRoot, operationId, ownership, snapshotStore })
      console.log(`operation root ${label} file write: PASS`)
    }

    const repo = path.join(tempRoot, 'operation-root-managed-repo')
    initRepo(repo)
    writeFileSync(path.join(repo, 'README.md'), 'operation root base\n')
    git(repo, ['add', 'README.md'])
    git(repo, ['commit', '-m', 'base'])
    const before = await Promise.all(stores.map((store) => store.getRevision()))
    const prepared = worktrees.prepareManagedWorktreeCreateEffect({
      sessionId: 'operation-root-managed-session', cwd: repo, isolated: true
    })
    assert(prepared.ok && prepared.isolated && prepared.plan, JSON.stringify(prepared))
    const created = await worktreeHandlers.executeManagedWorktreeCreateEffect(
      prepared.plan, undefined, gateway.executeInteractiveOperationEffect, ownership
    )
    assert.equal(created.ok, true, JSON.stringify(created))
    assert.equal(created.effectStatus, 'confirmed')
    assert(existsSync(created.record.worktreePath))
    assert(worktrees.listManagedWorktrees().some((item) => item.sessionId === created.record.sessionId))
    await assertRootBinding({
      roots, stores, before, expectedRoot: userData, operationId: created.operationId, ownership, snapshotStore
    })
    git(repo, ['worktree', 'remove', created.record.worktreePath])
    git(repo, ['branch', '-D', created.record.branch])
    console.log('operation root default canonical managed worktree: PASS')
  } finally {
    if (previousAppRoot === undefined) delete process.env.CAOGEN_TEST_USER_DATA
    else process.env.CAOGEN_TEST_USER_DATA = previousAppRoot
    if (previousLegacyRoot === undefined) delete process.env.CAOGEN_USER_DATA
    else process.env.CAOGEN_USER_DATA = previousLegacyRoot
  }
}

async function assertRootBinding({ roots, stores, before, expectedRoot, operationId, ownership, snapshotStore }) {
  assert(operationId, 'operation must expose its durable ID')
  const scopeId = `operation:${operationId}`
  for (const [index, root] of roots.entries()) {
    const runRefs = (await stores[index].getWorkItem(ownership.workItemId)).runRefs
    const runs = await snapshotStore.listTaskRuns(scopeId, root)
    if (root === expectedRoot) {
      assert.equal(runRefs.filter((id) => id === scopeId).length, 1, 'canonical task must own one operation Run')
      assert.equal(runs.length, 1)
      assert.equal(runs[0].status, 'completed')
      assert.equal(runs[0].effects.length, 1)
      assert.equal(runs[0].effects[0].status, 'confirmed')
      assert.equal(await snapshotStore.getTaskSnapshot(scopeId, root), null, 'completed recovery snapshot is removed')
    } else {
      assert.equal(runRefs.includes(scopeId), false, 'operation must not attach to another root')
      assert.equal(runs.length, 0, 'operation Run must not be persisted in another root')
      assert.equal(await stores[index].getRevision(), before[index], 'operation must not mutate another root')
    }
  }
}
