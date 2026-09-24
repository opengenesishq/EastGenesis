import { ensureProjectWorkspaceLedgerProjection } from './project-workspace/ledger-migration'
import {
  assertPersistedSessionDomainOwnership,
  type SessionDomainOwnership
} from './session-create-lifecycle'
import type { SessionMeta } from '../shared/types'
import { createDigitalWorkerSessionBinding, resolveDigitalWorkerSessionScope } from './digital-worker/session-binding'
import { createProjectWorkspaceCanonicalWriteBoundary } from './project-workspace/canonical-write'
import { resolveProjectWorkspaceRoot } from './project-workspace/persistence'
import { getTaskHostExecutionGate, taskHostSubject } from './task-handoff/execution-gate'

type SessionDomainActivationClaim = SessionDomainOwnership & { unassigned?: boolean; id?: string; createdAt?: number }

/**
 * Bind Session ownership to both persistence domains before a Run or Engine is
 * created. ProjectWorkspace remains the write source, so verify it again after
 * the projection to reject concurrent source changes.
 */
export async function prepareSessionDomainOwnershipForActivation(
  claim: SessionDomainActivationClaim,
  rootDir?: string
): Promise<SessionDomainOwnership> {
  if (claim.id) getTaskHostExecutionGate(resolveProjectWorkspaceRoot(rootDir)).assert({ sessionId: claim.id, sessionCreatedAt: claim.createdAt })
  const ownership = await assertPersistedSessionDomainOwnership(claim, rootDir)
  if (!ownership.workspaceId || claim.unassigned === true) return ownership

  const boundary = createProjectWorkspaceCanonicalWriteBoundary(resolveProjectWorkspaceRoot(rootDir))
  return boundary.withConsistentProjectionRead(async (stableRoot) => {
    const stableOwnership = await assertPersistedSessionDomainOwnership({ ...claim, ...ownership }, stableRoot)
    await ensureProjectWorkspaceLedgerProjection(stableOwnership.workspaceId!, stableRoot)
    return assertPersistedSessionDomainOwnership({ ...claim, ...stableOwnership }, stableRoot)
  })
}

export async function prepareSessionIdentityForActivation(
  meta: SessionMeta,
  rootDir: string,
  resuming: boolean
): Promise<SessionMeta> {
  getTaskHostExecutionGate(rootDir).assert(taskHostSubject(meta))
  const ownership = await prepareSessionDomainOwnershipForActivation(meta, rootDir)
  const owned = { ...meta, ...ownership }
  const digitalWorkerBinding = resuming
    ? resolveDigitalWorkerSessionScope(owned, rootDir, { allowLegacyUnscoped: true }).binding
    : createDigitalWorkerSessionBinding(owned, rootDir)
  return { ...owned, digitalWorkerBinding }
}
