import type { EffectRecord } from '../shared/types'
import { getPersistedArtifactLifecycle } from './task/artifact-lifecycle-api'
import type { ArtifactLifecycleRecord } from './task/artifact-lifecycle-types'
import { TaskKernel } from './task/task-kernel'
import type { ProjectPermanentDeletionEffectTarget } from './project-deletion-effect-target'

type ConfirmedProjectPermanentDeletionEffect = EffectRecord & {
  status: 'confirmed'
  target: ProjectPermanentDeletionEffectTarget
}

export function isConfirmedProjectPermanentDeletionEffect(
  effect: EffectRecord
): effect is ConfirmedProjectPermanentDeletionEffect {
  return effect.status === 'confirmed' && effect.target.kind === 'project_permanent_deletion'
}

export async function recoverConfirmedProjectPermanentDeletionArtifact(
  effect: ConfirmedProjectPermanentDeletionEffect,
  rootDir?: string
): Promise<ArtifactLifecycleRecord> {
  const lifecycle = await getPersistedArtifactLifecycle(effect.target.artifactId, rootDir)
  if (!lifecycle || lifecycle.projectId !== effect.target.projectId || lifecycle.goalId !== effect.target.goalId ||
      lifecycle.workItemId !== effect.target.workItemId || lifecycle.runId !== effect.target.runId ||
      lifecycle.kind !== 'report' || lifecycle.storageKind !== 'blob') {
    throw new Error(`confirmed Project deletion report is missing or crosses ownership:${effect.id}`)
  }
  await new TaskKernel(rootDir).deliver({
    rootDir,
    goalId: effect.target.goalId,
    workItemId: effect.target.workItemId
  }, {
    status: 'passed',
    evidenceRefs: [effect.target.evidenceId],
    verifiedBy: 'project-permanent-deletion'
  })
  return lifecycle
}
