import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { SessionMeta } from '../../shared/types'
import type { StudioResultFileCheck, StudioResultFileObservation } from '../../shared/studio-result-file-change-types'
import { currentArtifactLineageLeafIds } from '../task/artifact-lineage'
import { findArtifactLifecycle, findArtifactPurge } from '../task/artifact-lifecycle-store'
import { resolveLifecycleRoots } from '../task/artifact-lifecycle-api'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import { readWorkflowFileChangeRepairDatabase } from '../task/workflow-file-change-reader'
import { digest } from '../task/workflow-ledger-codec'
import { readAcceptances, readArtifacts, readEvidenceLinks, readRuns } from '../task/workflow-ledger-query'
import { setupWorkflowLedgerSchema, verifyWorkflowLedger } from '../task/workflow-ledger-store'
import { readArtifactEdges, verifyWorkflowArtifactGraph, verifyWorkflowArtifactGraphStructure } from '../task/workflow-ledger-artifact-graph-query'
import { buildWorkflowChangeImpactPlan } from '../task/workflow-change-impact'
import { assertAcceptanceEvidenceRefs } from '../task/workflow-acceptance-guard'
import { verifyWorkflowEvidence } from '../task/workflow-evidence-store'
import { commitProjectWorkspaceFileChangeImpact } from '../project-workspace/file-change-impact'

const MAX_FILE_BYTES = 128 * 1024 * 1024
const MAX_CHECK_BYTES = 512 * 1024 * 1024
const CHECK_EVENT = 'workflow.studio.result.files.checked'

/** Main-process Session only. A full result cannot be loaded while its old Acceptance references changed bytes. */
export async function checkStudioResultFiles(
  session: Pick<SessionMeta, 'id' | 'workspaceId' | 'goalId' | 'workItemId'>,
  rootDir?: string,
  now = Date.now()
): Promise<StudioResultFileCheck> {
  const projectId = session.workspaceId
  if (!projectId || !Number.isFinite(now)) {
    throw new Error('STUDIO_FILE_CHECK_SCOPE: a canonical Project result is required')
  }
  const roots = resolveLifecycleRoots(rootDir)
  const state = await (await openProjectWorkspaceStore(roots.workspaceRoot)).getState()
  if (!state.workspaces.some(project => project.id === projectId) ||
      (session.goalId && !state.goals.some(goal => goal.id === session.goalId && goal.projectId === projectId)) ||
      (session.workItemId && !state.workItems.some(item => item.id === session.workItemId && item.projectId === projectId &&
        (!session.goalId || item.goalId === session.goalId)))) {
    throw new Error('STUDIO_FILE_CHECK_SCOPE: Session ownership is no longer valid')
  }
  const items = state.workItems.filter(item => item.projectId === projectId &&
    (session.workItemId ? item.id === session.workItemId : session.goalId ? item.goalId === session.goalId : true))
  const itemIds = new Set(items.map(item => item.id)), artifactRefs = new Set(items.flatMap(item => item.artifactRefs))
  const observed = await readWorkflowFileChangeRepairDatabase(roots.workflowRoot, async db => {
    setupWorkflowLedgerSchema(db)
    // Keep event/ownership checks intact while allowing only the known stale
    // Acceptance byte references to be invalidated through the normal API.
    const { events, locations } = verifyWorkflowArtifactGraphStructure(db)
    const artifacts = readArtifacts(db).filter(artifact => artifact.projectId === projectId)
    const heads = currentArtifactLineageLeafIds(artifacts)
    const runIds = new Set(readRuns(db).filter(run => run.projectId === projectId &&
      (session.workItemId ? run.workItemId === session.workItemId : session.goalId ? run.goalId === session.goalId : true)).map(run => run.id))
    const selected = artifacts.filter(artifact => heads.has(artifact.id) && (artifactRefs.has(artifact.id) ||
      Boolean(artifact.workItemId && itemIds.has(artifact.workItemId)) || Boolean(artifact.runId && runIds.has(artifact.runId)) ||
      (!session.workItemId && Boolean(session.goalId && artifact.goalId === session.goalId)) || (!session.goalId && !session.workItemId)))
    if (selected.length > 500) throw new Error('STUDIO_FILE_CHECK_LIMIT: too many current artifacts')
    const files: StudioResultFileObservation[] = []
    let remainingBytes = MAX_CHECK_BYTES
    for (const artifact of [...selected].sort((a, b) => a.id.localeCompare(b.id))) {
      const record = findArtifactLifecycle(db, artifact.id)
      const base = { artifactId: artifact.id, expectedDigest: artifact.digest }
      if (!record || record.storageKind !== 'source_ref' || !record.sourceRef || findArtifactPurge(db, artifact.id)) {
        files.push({ ...base, state: 'not_checkable', reason: 'no_local_source' })
        continue
      }
      if (record.projectId !== projectId || record.digest !== artifact.digest || record.version !== artifact.version ||
          record.workItemId !== artifact.workItemId || record.runId !== artifact.runId) {
        throw new Error('STUDIO_FILE_CHECK_INTEGRITY: lifecycle and artifact ownership differ')
      }
      const location = locations.find(location => location.id === record.locationId)
      if (!location || location.artifactId !== artifact.id || location.projectId !== projectId ||
          location.path !== record.sourceRef || location.checksum !== record.digest || location.sizeBytes !== record.sizeBytes) {
        throw new Error('STUDIO_FILE_CHECK_INTEGRITY: source path differs from its immutable location')
      }
      const observed = await observeLocalFile(record.sourceRef, Math.min(MAX_FILE_BYTES, remainingBytes))
      remainingBytes -= observed.bytesRead
      files.push('digest' in observed
        ? { ...base, state: observed.digest === artifact.digest ? 'unchanged' : 'modified', observedDigest: observed.digest }
        : { ...base, state: 'unavailable', reason: observed.reason })
    }
    const changedArtifactIds = files.filter(file => file.state === 'modified' || file.state === 'unavailable').map(file => file.artifactId)
    const empty: StudioResultFileCheck = { checkedAt: now, files, changedArtifactIds,
      protectedArtifactIds: [], rerunWorkItemIds: [], reviewWorkItemIds: [], acceptanceIds: [], unresolvedReferences: [] }
    if (changedArtifactIds.length === 0) {
      verifyWorkflowArtifactGraph(db)
      return { result: empty }
    }

    const acceptances = readAcceptances(db).filter(acceptance => acceptance.projectId === projectId)
    // Invalidation must never erase a malformed Evidence selection, criterion,
    // verifier or declaration. Defer only the file reads already observed
    // above, then run the ordinary complete graph/ledger verifier at commit.
    verifyWorkflowEvidence(db)
    const observedChanges = new Set(changedArtifactIds)
    for (const acceptance of acceptances) assertAcceptanceEvidenceRefs(db, acceptance, observedChanges)
    verifyWorkflowLedger(db, { deferFileReadsForArtifactIds: observedChanges })
    const edges = readArtifactEdges(db).filter(edge => edge.projectId === projectId)
    const evidenceLinks = readEvidenceLinks(db).filter(link => link.projectId === projectId)
    const plan = buildWorkflowChangeImpactPlan({ projectId, changedArtifactIds,
      // A changed file's producer may write any of its outputs when rerun.
      manuallyModifiedArtifactIds: changedArtifactIds,
      artifacts, acceptances, edges, evidenceLinks })
    const fingerprint = digest({ projectId, files, edges, evidenceLinks,
      artifacts: artifacts.map(({ id, digest, version, workItemId }) => ({ id, digest, version, workItemId })),
      // A newly created repair's own pending review must not invalidate the
      // unchanged source observation that authorized that repair.
      acceptanceIds: plan.acceptanceRechecks.map(acceptance => acceptance.acceptanceId).sort() })
    const acceptancesById = new Map(acceptances.map(acceptance => [acceptance.id, acceptance]))
    // Repeated checks of the same bytes must not churn Acceptance revisions. A
    // later verification decision requires a new invalidation of those bytes.
    const previous = events.filter(event => event.projectId === projectId && event.kind === CHECK_EVENT &&
      event.payload.fingerprint === fingerprint).at(-1)
    if (previous) {
      const after = previous.payload.acceptancesAfter as Array<{ id: string; status: string; revision: number }>
      const result = previous.payload.result as unknown as StudioResultFileCheck
      if (Array.isArray(after) && after.every(value => {
        const current = acceptancesById.get(value.id)
        return current?.status === value.status && current.revision === value.revision
      })) {
        verifyWorkflowArtifactGraph(db)
        return { result: { ...result, checkedAt: now } }
      }
    }
    const result: StudioResultFileCheck = { ...empty, planDigest: plan.planDigest,
      protectedArtifactIds: plan.protectedArtifactIds,
      rerunWorkItemIds: plan.rerunWorkItemIds,
      reviewWorkItemIds: plan.reviewWorkItemIds,
      acceptanceIds: plan.acceptanceRechecks.map(recheck => recheck.acceptanceId),
      unresolvedReferences: plan.unresolvedReferences }
    return { plan, fingerprint, result }
  })
  if (observed.plan) {
    await commitProjectWorkspaceFileChangeImpact({ projectId, plan: observed.plan, rootDir: roots.workflowRoot, now,
      fileCheck: { fingerprint: observed.fingerprint, sessionId: session.id, result: observed.result } })
  }
  return observed.result
}

type FileObservation = { bytesRead: number } & ({ digest: string } | { reason: NonNullable<StudioResultFileObservation['reason']> })

export async function observeLocalFile(path: string, limit: number): Promise<FileObservation> {
  let bytesRead = 0
  try {
    // Lifecycle source paths are canonical at registration. Reject later
    // symlink substitutions, including parent-directory substitutions.
    if (!isAbsolute(path) || await realpath(path) !== resolve(path)) return { bytesRead, reason: 'unsafe_path' }
    const pathBefore = await lstat(path, { bigint: true })
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) return { bytesRead, reason: 'unsafe_path' }
    if (pathBefore.size > BigInt(limit)) return { bytesRead, reason: 'size_limit' }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino) return { bytesRead, reason: 'unstable' }
      const hash = createHash('sha256')
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        bytesRead += chunk.length
        if (bytesRead > limit) return { bytesRead, reason: 'size_limit' }
        hash.update(chunk)
      }
      const after = await handle.stat({ bigint: true }), pathAfter = await lstat(path, { bigint: true })
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
          after.dev !== pathAfter.dev || after.ino !== pathAfter.ino || await realpath(path) !== resolve(path)) {
        return { bytesRead, reason: 'unstable' }
      }
      return { bytesRead, digest: `sha256:${hash.digest('hex')}` }
    } finally { await handle.close() }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { bytesRead, reason: code === 'ENOENT' ? 'missing' : code === 'ELOOP' ? 'unsafe_path' : 'unreadable' }
  }
}
