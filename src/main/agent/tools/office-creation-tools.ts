import type { ToolExecutionOptions } from '../../openaiTools'
import { executeOfficeArtifactTool } from './office-artifact'
import type { ToolExecResult } from './tool-types'
import { clipToolOutput } from '../tool-output'

export async function executeOfficeCreationTool(name: string, args: Record<string, unknown>, cwd: string, options: ToolExecutionOptions): Promise<ToolExecResult> {
  const artifact = await executeOfficeArtifactTool(name, args, cwd, options.effectTarget, options.signal)
  return { ok: true, output: clipToolOutput(JSON.stringify({ path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes,
    mediaType: artifact.mediaType, artifactKind: artifact.artifactKind, title: artifact.title, sourceRefs: artifact.sourceRefs })) }
}
