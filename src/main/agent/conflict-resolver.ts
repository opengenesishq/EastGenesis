import type { TaskDagAutoMergeConflict } from '../../shared/types'

export interface ConflictResolverInput {
  taskId: string
  sessionId?: string
  branch?: string
  conflicts: TaskDagAutoMergeConflict[]
  taskSummary?: string
}

export interface ConflictResolverRequest {
  prompt: string
  files: Array<{
    path: string
    base: string
    worktree: string
    main: string
  }>
}

function cap(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max)}\n[已截断]` : text
}

function conflictBlock(file: TaskDagAutoMergeConflict): string {
  return [
    `### ${file.path}`,
    '#### base',
    '```',
    cap(file.base),
    '```',
    '#### main',
    '```',
    cap(file.main),
    '```',
    '#### worktree',
    '```',
    cap(file.worktree),
    '```'
  ].join('\n')
}

export function buildConflictResolverRequest(input: ConflictResolverInput): ConflictResolverRequest {
  const files = input.conflicts.map((file) => ({
    path: file.path,
    base: file.base,
    worktree: file.worktree,
    main: file.main
  }))
  const prompt = [
    '你是 EastGenesis 的冲突解决 Agent。请结合 base/main/worktree 三份内容生成最终合并结果。',
    `任务: ${input.taskId}`,
    input.sessionId ? `子会话: ${input.sessionId}` : '',
    input.branch ? `分支: ${input.branch}` : '',
    input.taskSummary ? `子任务摘要:\n${cap(input.taskSummary, 1600)}` : '',
    '',
    '要求:',
    '1. 保留 main 与 worktree 的有效意图。',
    '2. 不输出冲突标记。',
    '3. 逐文件给出最终内容和理由。',
    '4. 如果无法安全判断，明确标记 needs-human-review。',
    '',
    ...input.conflicts.map(conflictBlock)
  ]
    .filter(Boolean)
    .join('\n')

  return { prompt, files }
}
