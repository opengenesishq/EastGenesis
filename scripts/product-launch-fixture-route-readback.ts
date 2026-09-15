import process from 'node:process'
import { getTaskSnapshot } from '../src/main/task/task-snapshot'
import { frozenRoutingPolicyForRun } from '../src/main/task/frozen-routing-policy'

const [rootDir, sessionId, runId, expectedDigest] = process.argv.slice(2)

if (!rootDir || !sessionId || !runId || !expectedDigest) {
  throw new Error('route readback requires rootDir, sessionId, runId and expected digest')
}

async function main(): Promise<void> {
  const snapshot = await getTaskSnapshot(sessionId, rootDir)
  if (!snapshot?.run || snapshot.run.id !== runId) throw new Error('route readback Run identity mismatch')
  const policy = frozenRoutingPolicyForRun(snapshot.run)
  if (!policy || policy.policyDigest !== expectedDigest) throw new Error('route readback policy digest mismatch')
  if (policy.owner.sessionId !== sessionId || policy.owner.taskId !== snapshot.taskId) {
    throw new Error('route readback owner mismatch')
  }

  console.log(JSON.stringify({ status: 'passed', runId, policyDigest: policy.policyDigest, target: policy.initialTarget }))
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
