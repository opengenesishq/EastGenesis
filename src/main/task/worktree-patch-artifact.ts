import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { WorktreePatchResult } from '../../shared/types'
import type { ArtifactLifecycleRootInput } from './artifact-lifecycle-types'
import { registerSessionProducedArtifacts } from './session-artifact-producer'

/** Retain the exact exported bytes; this receipt does not authorize a code/test stage. */
export async function registerExportedWorktreePatch(
  owner: {
    sessionId: string
    projectId: string
    creatingRunId: string
    rootInput: ArtifactLifecycleRootInput
  },
  exported: Extract<WorktreePatchResult, { ok: true }>
): Promise<WorktreePatchResult> {
  try {
    if (!exported.path || !exported.baseSha || !exported.headSha || !exported.sha256 ||
        !Number.isSafeInteger(exported.bytes) || exported.bytes! < 0) {
      throw new Error('Exported patch lacks its byte and Git identity receipt')
    }
    const bytes = readFileSync(exported.path)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (bytes.length !== exported.bytes || sha256 !== exported.sha256) {
      throw new Error('Exported patch bytes changed before Artifact registration')
    }
    const [binding] = await registerSessionProducedArtifacts({
      ...owner,
      producerInvocationId: `worktree-patch:${exported.baseSha}:${exported.headSha}:${sha256}`,
      artifacts: [{
        kind: 'patch',
        title: 'Exported worktree patch',
        content: { storageKind: 'blob', bytes, expectedDigest: `sha256:${sha256}` },
        lineageKey: `worktree-patch:${owner.sessionId}`,
        mediaType: 'text/x-diff',
        producer: 'worktree_patch_export',
        metadata: {
          schemaVersion: 1,
          baseSha: exported.baseSha,
          headSha: exported.headSha,
          patchSha256: sha256,
          patchBytes: bytes.length,
          verificationScope: 'exported_bytes_integrity'
        },
        evidenceKind: 'delivery_check',
        evidenceSummary: 'The exported patch bytes match the export digest and byte count and are retained under the creating canonical Run.',
        evidenceVerifier: 'worktree-patch-export',
        acceptanceCriterion: 'The exported patch bytes, digest, length and canonical ownership must be internally consistent and retained. This check does not verify patch applicability, tests, code quality or task completion.',
        attachToStage: false
      }]
    })
    if (!binding?.artifactId || !binding.evidenceId || !binding.acceptanceId) {
      throw new Error('Canonical patch Artifact returned an incomplete evidence binding')
    }
    return {
      ...exported,
      workflowArtifactId: binding.artifactId,
      workflowEvidenceId: binding.evidenceId,
      workflowAcceptanceId: binding.acceptanceId
    }
  } catch (error) {
    return {
      ok: false,
      error: `Patch 已导出，但成果证据登记失败：${error instanceof Error ? error.message : String(error)}`,
      ...(exported.path && typeof exported.bytes === 'number'
        ? { savedPatch: { path: exported.path, bytes: exported.bytes } }
        : {})
    }
  }
}
