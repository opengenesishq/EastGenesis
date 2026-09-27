import { createHash } from 'node:crypto'
import type {
  ProjectContextReadResult
} from '../shared/types'
import type { ProjectContextOperationResult } from '../shared/project-context-types'
import { readProjectContext, resolveProjectRoot } from './agent/context-loader'
import { writeTextFile } from './fileOps'
import {
  executeInteractiveOperationEffect,
  type InteractiveOperationEffectOutcome
} from './task/operation-effect-gateway'

type OperationGateway = typeof executeInteractiveOperationEffect
type ProjectContextWriteResult = ProjectContextOperationResult<ProjectContextReadResult>
type ProjectContextWriteAttempt =
  | { ok: true; context: ProjectContextReadResult }
  | { ok: false; error: string }
type CompletedOutcome = Extract<
  InteractiveOperationEffectOutcome<ProjectContextWriteAttempt>,
  { status: 'completed' }
>

export async function executeProjectContextWriteEffect(
  projectPath: unknown,
  content: unknown,
  runOperation: OperationGateway
): Promise<ProjectContextWriteResult> {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    return { ok: false, error: '必须指定项目目录' }
  }
  const safeContent = typeof content === 'string' ? content : ''
  let projectRoot: string
  try {
    projectRoot = resolveProjectRoot(projectPath)
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }

  const outcome = await runOperation({
    kind: 'file_write',
    title: '保存 EastGenesis 项目规则',
    sourceSessionId: projectContextSourceId(projectRoot),
    cwd: projectRoot,
    toolName: 'write_file',
    toolInput: { path: 'caogen.md', content: safeContent },
    execute: async (effect): Promise<ProjectContextWriteAttempt> => {
      if (effect.target.kind !== 'file_content' || effect.target.relativePath !== 'caogen.md') {
        throw new Error('项目规则 EffectTarget 类型或路径不匹配')
      }
      const result = await writeTextFile(projectRoot, 'caogen.md', safeContent)
      return result.ok === true
        ? { ok: true, context: readProjectContext(projectRoot) }
        : { ok: false, error: result.error }
    },
    isSuccess: (result) => result.ok,
    resultSummary: (result) => result.ok === true ? 'EastGenesis project rules saved' : result.error
  })

  return outcome.status === 'completed'
    ? completedProjectContextResult(projectRoot, outcome)
    : {
        ok: false,
        error: outcome.error,
        effectStatus: outcome.effectStatus,
        operationId: outcome.operationId,
        ...(outcome.status === 'waiting_reconciliation' ? { snapshotId: outcome.snapshotId } : {})
      }
}

function completedProjectContextResult(
  projectRoot: string,
  outcome: CompletedOutcome
): ProjectContextWriteResult {
  const context = outcome.value?.ok ? outcome.value.context : readProjectContext(projectRoot)
  return {
    ok: true,
    context,
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId
  }
}

function projectContextSourceId(projectRoot: string): string {
  const digest = createHash('sha256').update(projectRoot).digest('hex')
  return `project-context:${digest.slice(0, 40)}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
