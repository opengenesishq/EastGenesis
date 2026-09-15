import type { ToolExecutionOptions } from '../../openaiTools'
import { executeOfficeArtifactTool } from './office-artifact'
import type { ToolExecResult } from './tool-types'
import { clipToolOutput } from '../tool-output'
import { withDataLifecycleMutation } from '../../data-lifecycle/data-lifecycle-mutation-lock'
import { assertPreparationSessionNotDeleted } from '../../permission/preparation-permission-lifecycle'
import { assertPreparationToolScope, resolvePreparationToolScope } from '../../permission/preparation-tool-scope'

export async function executeOfficeCreationTool(name: string, args: Record<string, unknown>, cwd: string, options: ToolExecutionOptions): Promise<ToolExecResult> {
  const preparation = options.preparationPermission
  const artifact = await (preparation ? (async () => {
    const { sessionMeta, userDataRoot } = options
    if (!sessionMeta || !userDataRoot) throw new Error('Office 草稿缺少当前任务和准备区授权。')
    const assertWriteAuthorized = () => {
      assertPreparationSessionNotDeleted(userDataRoot, sessionMeta)
      assertPreparationToolScope(sessionMeta, { cwd, preparation }, userDataRoot, name)
      const scope = resolvePreparationToolScope(sessionMeta, name, args, userDataRoot)
      if (!scope.preparation || scope.cwd !== cwd) throw new Error('Office 草稿目标已不属于当前任务准备区。')
    }
    assertWriteAuthorized()
    // Rendering yields outside the lifecycle lock, so a user can revoke while
    // a large draft is being generated. Only the physical commit holds the lock.
    return executeOfficeArtifactTool(name, args, cwd, options.effectTarget, options.signal, {
      sourceCwd: sessionMeta.cwd, assertWriteAuthorized,
      withWriteAccess: (commit) => withDataLifecycleMutation(userDataRoot, commit)
    })
  })() : executeOfficeArtifactTool(name, args, cwd, options.effectTarget, options.signal, {
    assertWriteAuthorized: options.assertFormalWriteAuthorized
  }))
  return { ok: true, output: clipToolOutput(JSON.stringify({ path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes,
    mediaType: artifact.mediaType, artifactKind: artifact.artifactKind, title: artifact.title, sourceRefs: artifact.sourceRefs })) }
}
