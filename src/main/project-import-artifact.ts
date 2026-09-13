import type { EffectRecord } from '../shared/types'
import { getPersistedArtifactLifecycle } from './task/artifact-lifecycle-api'
import type { ArtifactLifecycleRecord } from './task/artifact-lifecycle-types'
import { TaskKernel } from './task/task-kernel'
import type { ProjectPortableImportEffectTarget } from './project-import-effect-target'

type ConfirmedProjectPortableImportEffect = EffectRecord & {
  status: 'confirmed'
  target: ProjectPortableImportEffectTarget
}

export function isConfirmedProjectPortableImportEffect(
  effect: EffectRecord
): effect is ConfirmedProjectPortableImportEffect {
  return effect.status === 'confirmed' && effect.target.kind === 'project_portable_import'
}

export async function recoverConfirmedProjectPortableImportArtifact(
  effect: ConfirmedProjectPortableImportEffect,
  rootDir?: string
): Promise<ArtifactLifecycleRecord> {
  const lifecycle = await getPersistedArtifactLifecycle(effect.target.artifactId, rootDir)
  if (!lifecycle || lifecycle.projectId !== effect.target.projectId || lifecycle.goalId !== effect.target.goalId ||
      lifecycle.workItemId !== effect.target.workItemId || lifecycle.runId !== effect.target.runId ||
      lifecycle.kind !== 'report' || lifecycle.storageKind !== 'blob') {
    throw new Error(`confirmed Project import report is missing or crosses ownership:${effect.id}`)
  }
  await new TaskKernel(rootDir).deliver({
    rootDir,
    goalId: effect.target.goalId,
    workItemId: effect.target.workItemId
  }, {
    status: 'passed',
    evidenceRefs: [effect.target.evidenceId],
    verifiedBy: 'project-portable-import'
  })
  return lifecycle
}
