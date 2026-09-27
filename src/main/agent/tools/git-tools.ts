import {
  detectProviderFromRemoteUrl,
  gitCommit,
  gitCreatePr,
  gitDiff,
  gitMerge,
  gitPush,
  gitStatus,
  type GitCommitOperationResult,
  type GitCreatePrOperationResult,
  type GitDiffOperationResult,
  type GitMergeOperationResult,
  type GitPushOperationResult,
  type GitStatusOperationResult
} from '../../git/git-helper'
import type { EffectTarget, GitOperationResult } from '../../../shared/types'
import { executeGitIndexEffectTarget } from '../../git/git-index-effect'
import { executePullRequestEffectTarget } from '../../git/pull-request-effect'
import { executeIssueEffectTarget } from '../../git/pull-request-effect'
import {
  formatCodeForgeDeliveryReport,
  runCodeForgeDelivery,
  type CodeForgeDeliveryResult,
  type CodeForgeWorktreeContext
} from '../../code-forge/delivery'
import type { ToolDefinition, ToolExecResult } from './tool-types'

export const GIT_TOOL_NAMES = [
  'git_status',
  'git_diff',
  'git_stage',
  'git_stage_all',
  'git_commit',
  'git_push',
  'git_create_pr',
  'git_create_issue',
  'git_merge',
  'code_forge_delivery'
] as const

export type GitToolName = (typeof GIT_TOOL_NAMES)[number]

export interface GitToolExecutionContext {
  sessionId?: string
  userDataRoot?: string
  worktreeContext?: CodeForgeWorktreeContext
  effectTarget?: EffectTarget
}

const GIT_TOOL_SET = new Set<string>(GIT_TOOL_NAMES)

export function isGitToolName(name: string): name is GitToolName {
  return GIT_TOOL_SET.has(name)
}

const OPTIONAL_BRANCH_SCHEMA = {
  branch: {
    type: 'string',
    description: '可选分支名；省略时使用当前分支。不会 force push。'
  }
} satisfies Record<string, Record<string, unknown>>

export const GIT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: '查看当前 Git 状态、分支、ahead/behind、已暂存/未暂存/未跟踪/冲突文件。只读工具。',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_create_issue',
      description:
        '在当前仓库对应的 GitHub/GitLab 项目创建 Issue。使用本机现有 gh/glab 登录，不接受 Token；创建前和恢复时按唯一 marker 对账，避免重复提交。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Issue 标题，不能为空。' },
          body: { type: 'string', description: 'Issue 正文，可为空。' },
          labels: { type: 'array', items: { type: 'string' }, description: '可选标签列表。' }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: '查看 staged 与 unstaged diff；可传 file 只看单个文件。只读工具，不包含未跟踪文件正文。',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: '可选仓库内相对路径或绝对路径。' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_stage',
      description:
        '把明确列出的仓库内文件暂存到 Git index。只接受普通相对文件路径；必须通过冻结的 git_index_update Effect 执行，不会退回 shell git add。',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: '要暂存的仓库内相对文件路径列表；不接受目录或 pathspec 魔法。'
          }
        },
        required: ['paths']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_stage_all',
      description:
        '暂存当前工作目录范围内的全部 Git 变更。必须通过冻结的 git_index_update Effect 执行；仅在确认全部改动都应纳入交付时使用。',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_commit',
      description:
        '提交已暂存改动。不会自动 git add，不会隐式执行项目规则命令或 Git hooks；需要验证时先显式调用 bash。',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '提交信息，不能为空。' }
        },
        required: ['message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_push',
      description:
        '显式 push 当前分支或指定分支到 remote。不会 force push，不会创建 PR；省略 branch 时使用当前分支。',
      parameters: {
        type: 'object',
        properties: OPTIONAL_BRANCH_SCHEMA
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_create_pr',
      description:
        '显式创建 GitHub PR 或 GitLab MR。不会自动 push；若远端分支不存在会要求先调用 git_push。Gitee remote 会识别但基础版不自动创建。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'PR/MR 标题，不能为空。' },
          body: { type: 'string', description: 'PR/MR 正文，可为空。' },
          base: { type: 'string', description: '可选目标分支；省略时尝试使用 origin/HEAD、main、master 或 develop。' }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_merge',
      description:
        '显式把指定分支合并到当前分支。要求当前工作区干净，并在隔离对象库中做冲突预检；有冲突时不会进入半合并状态。当前安全模式拒绝命令可扩展的 merge/filter 属性。',
      parameters: {
        type: 'object',
        properties: {
          branch: { type: 'string', description: '要合并进当前分支的来源分支。' }
        },
        required: ['branch']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'code_forge_delivery',
      description:
        '汇总 worktree/repo diff，生成报告或补丁。可用 verificationToolUseIds 引用当前 Run 中先前通过 bash recordVerification=true 执行的验证记录；只核对证据，不运行命令或自动提交。',
      parameters: {
        type: 'object',
        properties: {
          verificationToolUseIds: { type: 'array', items: { type: 'string' }, maxItems: 20, uniqueItems: true,
            description: '可选：当前 Run 中已完成的 bash 工具调用 ID；源码版本、命令与真实结果必须一致。' },
          mode: {
            type: 'string',
            enum: ['report', 'patch'],
            description: '交付模式:report 只生成报告;patch 额外生成补丁。默认 report。'
          }
        }
      }
    }
  }
]

export async function executeGitTool(
  name: GitToolName,
  args: Record<string, unknown>,
  cwd: string,
  context: GitToolExecutionContext = {}
): Promise<ToolExecResult> {
  switch (name) {
    case 'git_status':
      return stringifyResult(gitStatus(cwd))
    case 'git_diff':
      return stringifyResult(gitDiff(cwd, optionalString(args.file)))
    case 'git_stage':
    case 'git_stage_all':
      return executeGitIndexTool(name, args, cwd, context.effectTarget)
    case 'git_commit':
      return stringifyResult(gitCommit(cwd, requiredString(args.message, 'message')))
    case 'git_push':
      return stringifyResult(gitPush(cwd, optionalString(args.branch)))
    case 'git_create_pr':
      return executeCreatePullRequestTool(
        args,
        cwd,
        context.effectTarget?.kind === 'pull_request_create' ? context.effectTarget : undefined
      )
    case 'git_create_issue':
      return executeCreateIssueTool(args, cwd, context.effectTarget)
    case 'git_merge':
      return executeMergeTool(args, cwd, context.effectTarget)
    case 'code_forge_delivery':
      return executeCodeForgeDeliveryTool(args, cwd, context)
  }
}

async function executeCreateIssueTool(
  args: Record<string, unknown>,
  cwd: string,
  effectTarget: EffectTarget | undefined
): Promise<ToolExecResult> {
  if (effectTarget?.kind !== 'issue_create') {
    return stringifyIssueResult({ ok: false, error: 'git_create_issue 缺少冻结的 issue_create EffectTarget，已阻止执行' })
  }
  return stringifyIssueResult(await executeIssueEffectTarget({
    target: effectTarget,
    title: requiredString(args.title, 'title'),
    body: typeof args.body === 'string' ? args.body : '',
    labels: stringArray(args.labels)
  }))
}

function executeGitIndexTool(
  name: 'git_stage' | 'git_stage_all',
  args: Record<string, unknown>,
  cwd: string,
  effectTarget: EffectTarget | undefined
): ToolExecResult {
  const expectedOperation = name === 'git_stage' ? 'stage_paths' : 'stage_all'
  if (effectTarget?.kind !== 'git_index_update') {
    return stringifyResult({
      ok: false,
      error: `${name} 缺少冻结的 git_index_update EffectTarget，已阻止直接修改 Git index`
    })
  }
  if (effectTarget.operation !== expectedOperation) {
    return stringifyResult({
      ok: false,
      error: `${name} 与冻结的 Git index 操作 ${effectTarget.operation} 不一致，已阻止执行`
    })
  }
  return stringifyResult(executeGitIndexEffectTarget(effectTarget, {
    toolName: name,
    cwd,
    toolInput: args
  }))
}

async function executeCreatePullRequestTool(
  args: Record<string, unknown>,
  cwd: string,
  effectTarget: Extract<EffectTarget, { kind: 'pull_request_create' }> | undefined
): Promise<ToolExecResult> {
  const title = requiredString(args.title, 'title')
  const body = typeof args.body === 'string' ? args.body : ''
  const result = effectTarget
    ? await executePullRequestEffectTarget({ target: effectTarget, title, body })
    : gitCreatePr(cwd, title, body, optionalString(args.base))
  return stringifyResult(result)
}

function executeMergeTool(
  args: Record<string, unknown>,
  cwd: string,
  effectTarget: EffectTarget | undefined
): ToolExecResult {
  const frozen = effectTarget?.kind === 'git_merge'
    ? {
        repoRoot: effectTarget.repoRoot,
        gitCommonDir: effectTarget.gitCommonDir,
        worktreeGitDir: effectTarget.worktreeGitDir,
        repoRootIdentity: effectTarget.repoRootIdentity,
        gitCommonDirIdentity: effectTarget.gitCommonDirIdentity,
        worktreeGitDirIdentity: effectTarget.worktreeGitDirIdentity,
        destinationRef: effectTarget.destinationRef,
        preHead: effectTarget.preHead,
        sourceRef: effectTarget.sourceRef,
        sourceSha: effectTarget.sourceSha,
        sourceWasAncestor: effectTarget.sourceWasAncestor,
        mode: effectTarget.mode
      }
    : undefined
  return stringifyResult(gitMerge(cwd, requiredString(args.branch, 'branch'), frozen))
}

async function executeCodeForgeDeliveryTool(
  args: Record<string, unknown>,
  cwd: string,
  context: GitToolExecutionContext
): Promise<ToolExecResult> {
  const mode = deliveryMode(args.mode)
  if (mode === 'commit' || mode === 'pr') {
    return {
      ok: false,
      output: mode === 'commit'
        ? 'code_forge_delivery mode=commit 把 stage/commit 组合成单个不可对账副作用，已阻止；请依次显式暂存并调用 git_commit。'
        : 'code_forge_delivery mode=pr 把 commit/push/PR 组合成单个不可对账副作用，已阻止；请依次显式调用 git_commit、git_push、git_create_pr。'
    }
  }
  for (const field of ['repoRoot', 'worktreePath', 'baseSha', 'baseBranch', 'branch'] as const) {
    if (args[field] !== undefined) {
      return { ok: false, output: `code_forge_delivery 不接受模型覆盖 ${field}；目标只来自当前 session/worktree 上下文。` }
    }
  }
  if (args.verificationToolUseIds !== undefined && (!Array.isArray(args.verificationToolUseIds) || args.verificationToolUseIds.some((value) => typeof value !== 'string'))) {
    return { ok: false, output: 'verificationToolUseIds 必须是工具调用 ID 数组。' }
  }
  const verificationToolUseIds = args.verificationToolUseIds as string[] | undefined
  let verificationContext: import('../../code-forge/verification-evidence').CodeForgeVerificationContext | undefined
  if (verificationToolUseIds?.length && context.sessionId && context.userDataRoot) {
    const { taskRuntimeRegistry } = await import('../../task/task-runtime-registry')
    const { getTaskSnapshot } = await import('../../task/task-snapshot')
    const snapshot = await getTaskSnapshot(context.sessionId, context.userDataRoot)
    const current = taskRuntimeRegistry.get(context.sessionId)
    if (current && snapshot?.run?.id === current.id && snapshot.sessionId === context.sessionId) {
      const persistedRun = snapshot.run
      const consistent = verificationToolUseIds.every((id) => {
        const live = current.toolExecutions?.find((execution) => execution.toolUseId === id)
        const stored = persistedRun.toolExecutions?.find((execution) => execution.toolUseId === id)
        return live && stored && live.id === stored.id && live.status === stored.status && live.effectStatus === stored.effectStatus &&
          live.inputDigest === stored.inputDigest && live.outputDigest === stored.outputDigest && live.resultEventId === stored.resultEventId &&
          live.supersededByExecutionId === stored.supersededByExecutionId
      })
      if (consistent) verificationContext = { rootDir: context.userDataRoot, run: persistedRun, transcript: snapshot.transcript }
    }
  }
  return stringifyCodeForgeResult(runCodeForgeDelivery({
    cwd,
    mode,
    verificationToolUseIds,
    verificationContext,
    verificationCommand: args.verificationCommand as string | undefined,
    verificationCommands: args.verificationCommands as string[] | undefined,
    createPatch: typeof args.createPatch === 'boolean' ? args.createPatch : undefined,
    worktreeContext: {
      ...context.worktreeContext,
      sessionId: context.worktreeContext?.sessionId ?? context.sessionId
    }
  }, context.effectTarget?.kind === 'code_forge_patch' ? context.effectTarget : undefined))
}

export function formatGitResult(
  result:
    | GitStatusOperationResult
    | GitDiffOperationResult
    | GitCommitOperationResult
    | GitPushOperationResult
    | GitCreatePrOperationResult
    | GitMergeOperationResult
    | GitOperationResult
    | CodeForgeDeliveryResult
): string {
  return JSON.stringify(result, null, 2)
}

export function gitRemoteProvider(url: string): string {
  return detectProviderFromRemoteUrl(url)
}

function stringifyResult(
  result:
    | GitStatusOperationResult
    | GitDiffOperationResult
    | GitCommitOperationResult
    | GitPushOperationResult
    | GitCreatePrOperationResult
    | GitMergeOperationResult
    | GitOperationResult
): ToolExecResult {
  return { ok: result.ok, output: formatGitResult(result) }
}

function stringifyCodeForgeResult(result: CodeForgeDeliveryResult): ToolExecResult {
  return { ok: result.ok, output: formatCodeForgeDeliveryReport(result) }
}

function stringifyIssueResult(result: Awaited<ReturnType<typeof executeIssueEffectTarget>>): ToolExecResult {
  return { ok: result.ok, output: JSON.stringify(result, null, 2) }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 不能为空`)
  return value.trim()
}

function stringArray(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('labels 必须是字符串数组')
  }
  return value as string[]
}

function deliveryMode(value: unknown): 'report' | 'patch' | 'commit' | 'pr' | undefined {
  return value === 'report' || value === 'patch' || value === 'commit' || value === 'pr'
    ? value
    : undefined
}
