import type { EffectRecord } from '../../shared/types'
import { getPersistedArtifactLifecycle } from '../task/artifact-lifecycle-api'
import type { ArtifactLifecycleRecord } from '../task/artifact-lifecycle-types'
import { TaskKernel } from '../task/task-kernel'
import type { ProviderProfileOperationTarget } from './provider-profile-operation-target'

type ConfirmedProviderProfileOperationEffect = EffectRecord & {
  status: 'confirmed'
  target: ProviderProfileOperationTarget
}

export function isConfirmedProviderProfileOperationEffect(
  effect: EffectRecord
): effect is ConfirmedProviderProfileOperationEffect {
  return effect.status === 'confirmed' && effect.target.kind === 'provider_profile_operation'
}

export async function recoverConfirmedProviderProfileOperationArtifact(
  effect: ConfirmedProviderProfileOperationEffect,
  rootDir?: string
): Promise<ArtifactLifecycleRecord> {
  const lifecycle = await getPersistedArtifactLifecycle(effect.target.artifactId, rootDir)
  if (!lifecycle || lifecycle.projectId !== effect.target.projectId || lifecycle.goalId !== effect.target.goalId ||
      lifecycle.workItemId !== effect.target.workItemId || lifecycle.runId !== effect.target.runId ||
      lifecycle.kind !== 'report' || lifecycle.storageKind !== 'blob') {
    throw new Error(`confirmed Provider Profile report is missing or crosses ownership:${effect.id}`)
  }
  await new TaskKernel(rootDir).deliver({
    rootDir,
    goalId: effect.target.goalId,
    workItemId: effect.target.workItemId
  }, {
    status: 'passed',
    evidenceRefs: [effect.target.evidenceId],
    verifiedBy: 'provider-profile-operation'
  })
  return lifecycle
}
