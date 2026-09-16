import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BudgetOwner } from '../src/main/budget/canonical-request-budget'
import { canonicalRequestBudgets } from '../src/main/budget/canonical-request-budget'
import { readTaskBudget } from '../src/main/budget/task-budget-projection'
import { reserveRequestBudget, settleRequestBudget } from '../src/main/budget/request-budget-store'
import { SupervisorStateStore } from '../src/main/task/supervisor-state'
import { taskRuntimeRegistry } from '../src/main/task/task-runtime-registry'

const root = mkdtempSync(join(tmpdir(), 'caogen-task-budget-view-'))
const projectId = 'project', goalId = 'goal'
const state = { schemaVersion: 1, revision: 1, workspaces: [{ id: projectId, status: 'active' }],
  goals: [{ id: goalId, projectId, title: 'Customer report', budget: { amount: 2, currency: 'USD' } },
    { id: 'other', projectId, title: 'Other', budget: { amount: 2 } }],
  workItems: ['a', 'b'].map(id => ({ id, projectId, goalId })), events: [] }
const save = () => writeFileSync(join(root, 'project-workspace.json'), JSON.stringify(state))
const meta = (id: string): BudgetOwner => ({ id, workspaceId: projectId, goalId, workItemId: id, sdkSessionId: `sdk-${id}`, costUsd: 0 })
const a = meta('a'), b = meta('b')
const scope = (owner: BudgetOwner) => ({ sessionId: owner.id, sdkSessionId: owner.sdkSessionId, sessionTextCostUsd: owner.costUsd,
  monthlyTextSpentUsd: 0, observedSessions: [owner], aggregateBudgetIds: canonicalRequestBudgets(owner, [], root).ids })
const reserve = (id: string, owner: BudgetOwner, amount: number | undefined, kind: 'model' | 'media' = 'model') =>
  reserveRequestBudget({ rootDir: root, id, kind, providerId: 'fixture', estimatedUsd: amount, scope: scope(owner) })
const close = (actual: number | undefined, expected: number) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)
let passed = 0
const pass = (name: string) => { passed++; console.log(`PASS ${name}`) }

async function main() {
  save()
  reserve('a-first', a, .6); settleRequestBudget({ rootDir: root, id: 'a-first', status: 'settled', actualUsd: .4 })
  reserve('a-pending', a, .3); reserve('b-pending', b, .2)
  reserve('media', b, .2, 'media'); settleRequestBudget({ rootDir: root, id: 'media', status: 'settled', actualUsd: .1 })
  const ledgerBefore = readFileSync(join(root, 'request-budget-reservations.json'), 'utf8')
  let view = readTaskBudget(b, [], root)
  close(view.recordedSpentUsd, .5); close(view.reservedUsd, .5); close(view.remainingUsd, 1)
  assert.equal(view.reservedCount, 2); assert.equal(view.uncertainCount, 0)
  assert.equal(view.remainingState, 'available')
  assert.equal(readFileSync(join(root, 'request-budget-reservations.json'), 'utf8'), ledgerBefore)
  pass('read-only Goal view includes sibling text/media costs and concurrent reservations')

  const observedA = { ...a, costUsd: .4 }
  view = readTaskBudget(b, [observedA, observedA, b], root)
  close(view.recordedSpentUsd, .5); close(view.remainingUsd, 1)
  const supervisor = new SupervisorStateStore(root)
  await supervisor.createRun({ id: 'run-a', projectId, goalId, workItemId: a.id, budget: { amount: 2 } })
  const supervisorFile = join(root, 'supervisor-state.json'), supervisorState = JSON.parse(readFileSync(supervisorFile, 'utf8'))
  supervisorState.runs[0].usage.costUsd = .4
  writeFileSync(supervisorFile, JSON.stringify(supervisorState))
  // Retained Run membership is normally bound before the physical request.
  taskRuntimeRegistry.set(a.id, { id: 'run-a', sessionId: a.id, toolExecutions: [] })
  reserve('membership', a, 0); settleRequestBudget({ rootDir: root, id: 'membership', status: 'released' })
  view = readTaskBudget(b, [], root)
  close(view.recordedSpentUsd, .5); close(view.remainingUsd, 1)
  pass('history duplicates and Supervisor totals do not double-charge, deleted history keeps durable spend')

  settleRequestBudget({ rootDir: root, id: 'b-pending', status: 'unknown' })
  view = readTaskBudget(b, [], root)
  assert.equal(view.remainingState, 'unknown'); assert.equal(view.remainingUsd, undefined)
  assert.equal(view.uncertainCount, 1); close(view.uncertainHeldUsd, .2); close(view.reservedUsd, .3)
  settleRequestBudget({ rootDir: root, id: 'b-pending', status: 'settled', actualUsd: .15 })
  view = readTaskBudget(b, [], root)
  close(view.recordedSpentUsd, .65); close(view.remainingUsd, 1.05)
  pass('unknown outcomes retain their estimate and hide allowance until actual reconciliation')

  reserve('estimate-only', b, .1); settleRequestBudget({ rootDir: root, id: 'estimate-only', status: 'settled' })
  view = readTaskBudget(b, [], root)
  assert.equal(view.remainingState, 'unknown'); assert.equal(view.remainingUsd, undefined)
  close(view.recordedSpentUsd, .65); assert.equal(view.uncertainCount, 1)
  settleRequestBudget({ rootDir: root, id: 'estimate-only', status: 'settled', actualUsd: .08 })
  state.goals[0].budget.amount = 0; save()
  view = readTaskBudget(b, [], root)
  assert.equal(view.remainingState, 'unlimited'); assert.equal(view.remainingUsd, undefined)
  close(view.recordedSpentUsd, .73); close(view.reservedUsd, .3)
  pass('settled estimates are not actual spend; an unset limit still shows persistent costs')

  reserve('unpriced-pending', b, undefined)
  view = readTaskBudget(b, [], root)
  assert.equal(view.unpricedReservedCount, 1); assert.equal(view.remainingState, 'unknown')
  assert.equal(view.uncertainCount, 1); assert.equal(view.reservedCount, 2)
  settleRequestBudget({ rootDir: root, id: 'unpriced-pending', status: 'released' })
  pass('unpriced in-flight requests explicitly mark the reservation total as incomplete')

  state.goals[0].budget.amount = 3; save()
  view = readTaskBudget(a, [], root)
  close(view.goalLimitUsd, 3); close(view.frozenRunLimitUsd, 2); close(view.limitUsd, 2); close(view.remainingUsd, .97)
  close(readTaskBudget(b, [], root).remainingUsd, 1.97)
  const foreign = { ...b, id: 'other-session', sdkSessionId: 'other-sdk', goalId: 'other', workItemId: undefined }
  close(readTaskBudget(foreign, [], root).recordedSpentUsd, 0)
  close(readTaskBudget(foreign, [], root).remainingUsd, 2)
  pass('current run cap survives a Goal increase and other Goals stay isolated')

  state.goals[0].budget.currency = 'CNY'; save()
  view = readTaskBudget(b, [], root)
  assert.equal(view.state, 'unavailable'); assert.equal(view.recordedSpentUsd, undefined); assert.equal(view.remainingUsd, undefined)
  state.goals[0].budget.currency = 'USD'; save()
  assert.equal(readTaskBudget({ ...b, workItemId: 'foreign' }, [], root).state, 'unavailable')
  assert.equal(readTaskBudget({ ...b, goalId: undefined }, [], root).state, 'unbound')
  writeFileSync(join(root, 'request-budget-reservations.json'), '{invalid')
  assert.equal(readTaskBudget(b, [], root).state, 'unavailable')
  pass('unsupported currency, mismatched ownership and corrupt ledgers never become zero balances')
  console.log(`Task budget projection checks: ${passed}/${passed} passed; no Provider calls.`)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  taskRuntimeRegistry.delete(a.id); rmSync(root, { recursive: true, force: true })
})
