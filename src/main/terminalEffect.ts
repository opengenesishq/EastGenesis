import { createHash } from 'node:crypto'
import type { EffectRecord } from '../shared/effect-types'
import type {
  TerminalActionResult,
  TerminalInfo,
  TerminalStartResult
} from '../shared/types'
import {
  executeInteractiveOperationEffect,
  type InteractiveOperationEffectOutcome
} from './task/operation-effect-gateway'
import { stableValueDigest } from './task/tool-idempotency'

type OperationGateway = typeof executeInteractiveOperationEffect

export interface TerminalEffectContext {
  executionEnvironment?: import('../shared/wsl-types').ExecutionEnvironmentBinding
  assertActive?: () => void
  sourceSessionId: string
  projectId?: string
  workspaceId?: string
  standalone?: boolean
  ownerWebContentsId?: number
  cwd: string
}

export interface TerminalEffectManager {
  get(id: string): TerminalInfo | undefined
  start(options: TerminalEffectStartOptions): Promise<TerminalInfo>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  close(id: string): void
}

interface TerminalEffectStartOptions {
  executionEnvironment?: import('../shared/wsl-types').ExecutionEnvironmentBinding
  cwd: string
  sessionId?: string
  ownerWebContentsId?: number
  workspaceId?: string
  projectId?: string
  cols?: number
  rows?: number
  reuse?: boolean
}

interface TerminalMutationSuccess {
  ok: true
}

const TERMINAL_TOOL_NAMES = {
  start: 'terminal_start',
  write: 'terminal_write',
  resize: 'terminal_resize',
  close: 'terminal_close'
} as const

export async function startTerminalWithEffect(
  context: TerminalEffectContext,
  manager: TerminalEffectManager,
  options: Pick<TerminalEffectStartOptions, 'cols' | 'rows' | 'reuse'>,
  runOperation: OperationGateway = executeInteractiveOperationEffect
): Promise<TerminalStartResult> {
  const prepared = {
    cols: normalizeDimension(options.cols, 80),
    rows: normalizeDimension(options.rows, 24),
    reuse: options.reuse !== false
  }
  const toolName = TERMINAL_TOOL_NAMES.start
  const outcome = await runOperation({
    kind: 'terminal_action',
    title: '启动终端',
    sourceSessionId: context.sourceSessionId,
    projectId: context.projectId,
    workspaceId: context.workspaceId,
    cwd: context.cwd,
    toolName,
    toolInput: {
      sourceKind: context.standalone ? 'workspace_human' : 'task',
      sessionIdDigest: stableValueDigest(context.sourceSessionId),
      cwdDigest: stableValueDigest(context.cwd),
      executionEnvironment: context.executionEnvironment,
      ...prepared
    },
    execute: (effect) => {
      assertOpaqueTerminalEffect(effect, toolName)
      context.assertActive?.()
      return manager.start({
        cwd: context.cwd,
        executionEnvironment: context.executionEnvironment,
        sessionId: context.standalone ? undefined : context.sourceSessionId,
        ownerWebContentsId: context.ownerWebContentsId,
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        ...prepared
      })
    },
    isSuccess: isTerminalInfo,
    resultSummary: summarizeTerminalStart
  })
  return { ...terminalStartOutcome(outcome), sourceKind: context.standalone ? 'workspace_human' : 'task' }
}

export async function writeTerminalWithEffect(
  manager: TerminalEffectManager,
  id: string,
  data: string,
  runOperation: OperationGateway = executeInteractiveOperationEffect
): Promise<TerminalActionResult> {
  const terminal = manager.get(id)
  if (!terminal) return missingTerminalResult()
  const toolName = TERMINAL_TOOL_NAMES.write
  const outcome = await runOperation({
    ...terminalOperationContext(terminal, id),
    kind: 'terminal_action',
    title: '向终端写入输入',
    toolName,
    toolInput: {
      sourceKind: terminalSourceKind(terminal),
      terminalIdDigest: stableValueDigest(id),
      dataSha256: createHash('sha256').update(data, 'utf8').digest('hex'),
      bytes: Buffer.byteLength(data, 'utf8')
    },
    execute: (effect) => {
      assertOpaqueTerminalEffect(effect, toolName)
      manager.write(id, data)
      return { ok: true } as const
    },
    isSuccess: isTerminalMutationSuccess,
    resultSummary: summarizeTerminalMutation
  })
  return { ...terminalActionOutcome(outcome, '终端输入'), sourceKind: terminalSourceKind(terminal) }
}

export async function resizeTerminalWithEffect(
  manager: TerminalEffectManager,
  id: string,
  cols: number,
  rows: number,
  runOperation: OperationGateway = executeInteractiveOperationEffect
): Promise<TerminalActionResult> {
  const terminal = manager.get(id)
  if (!terminal) return missingTerminalResult()
  const prepared = {
    cols: normalizeDimension(cols, terminal.cols),
    rows: normalizeDimension(rows, terminal.rows)
  }
  const toolName = TERMINAL_TOOL_NAMES.resize
  const outcome = await runOperation({
    ...terminalOperationContext(terminal, id),
    kind: 'terminal_action',
    title: '调整终端尺寸',
    toolName,
    toolInput: { sourceKind: terminalSourceKind(terminal), terminalIdDigest: stableValueDigest(id), ...prepared },
    execute: (effect) => {
      assertOpaqueTerminalEffect(effect, toolName)
      manager.resize(id, prepared.cols, prepared.rows)
      return { ok: true } as const
    },
    isSuccess: isTerminalMutationSuccess,
    resultSummary: summarizeTerminalMutation
  })
  return { ...terminalActionOutcome(outcome, '终端尺寸调整'), sourceKind: terminalSourceKind(terminal) }
}

export async function closeTerminalWithEffect(
  manager: TerminalEffectManager,
  id: string,
  runOperation: OperationGateway = executeInteractiveOperationEffect
): Promise<TerminalActionResult> {
  const terminal = manager.get(id)
  if (!terminal) return { ok: true }
  const toolName = TERMINAL_TOOL_NAMES.close
  const outcome = await runOperation({
    ...terminalOperationContext(terminal, id),
    kind: 'terminal_action',
    title: '关闭终端',
    toolName,
    toolInput: { sourceKind: terminalSourceKind(terminal), terminalIdDigest: stableValueDigest(id) },
    execute: (effect) => {
      assertOpaqueTerminalEffect(effect, toolName)
      manager.close(id)
      return { ok: true } as const
    },
    isSuccess: isTerminalMutationSuccess,
    resultSummary: summarizeTerminalMutation
  })
  return { ...terminalActionOutcome(outcome, '终端关闭'), sourceKind: terminalSourceKind(terminal) }
}

function terminalSourceKind(terminal: TerminalInfo): 'task' | 'workspace_human' {
  return terminal.sessionId ? 'task' : 'workspace_human'
}

function terminalOperationContext(terminal: TerminalInfo, id: string): TerminalEffectContext {
  return {
    sourceSessionId: terminal.sessionId ?? `terminal:unscoped:${stableValueDigest(id).slice(0, 16)}`,
    cwd: terminal.cwd,
    projectId: terminal.projectId,
    workspaceId: terminal.workspaceId
  }
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(1000, Math.max(2, Math.floor(value)))
}

function assertOpaqueTerminalEffect(effect: EffectRecord, toolName: string): void {
  if (effect.target.kind !== 'unsupported' || effect.target.toolName !== toolName) {
    throw new Error('终端动作必须保持 opaque 并与工具名绑定')
  }
}

function isTerminalInfo(value: TerminalInfo): boolean {
  return Boolean(value && typeof value.id === 'string' && typeof value.cwd === 'string')
}

function isTerminalMutationSuccess(value: TerminalMutationSuccess): boolean {
  return value.ok
}

function terminalStartOutcome(
  outcome: InteractiveOperationEffectOutcome<TerminalInfo>
): TerminalStartResult {
  if (outcome.status === 'completed' && outcome.value) {
    return {
      ok: true,
      terminal: outcome.value,
      effectStatus: outcome.effectStatus,
      operationId: outcome.operationId
    }
  }
  if (outcome.status === 'waiting_reconciliation') {
    return {
      ok: false,
      error: '终端启动结果未知，请在恢复面板完成对账',
      effectStatus: outcome.effectStatus,
      operationId: outcome.operationId,
      snapshotId: outcome.snapshotId
    }
  }
  return {
    ok: false,
    error: outcome.status === 'failed' ? outcome.error : '终端启动效果已确认，但执行结果缺失',
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId
  }
}

function terminalActionOutcome(
  outcome: InteractiveOperationEffectOutcome<TerminalMutationSuccess>,
  label: string
): TerminalActionResult {
  if (outcome.status === 'completed' && outcome.value?.ok) {
    return { ok: true, effectStatus: outcome.effectStatus, operationId: outcome.operationId }
  }
  if (outcome.status === 'waiting_reconciliation') {
    return {
      ok: false,
      error: `${label}结果未知，请在恢复面板完成对账`,
      effectStatus: outcome.effectStatus,
      operationId: outcome.operationId,
      snapshotId: outcome.snapshotId
    }
  }
  return {
    ok: false,
    error: outcome.status === 'failed' ? outcome.error : `${label}效果已确认，但执行结果缺失`,
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId
  }
}

function missingTerminalResult(): TerminalActionResult {
  return { ok: false, error: '终端不存在或已关闭' }
}

function summarizeTerminalStart(terminal: TerminalInfo): string {
  return JSON.stringify({
    backend: terminal.backend,
    cols: terminal.cols,
    rows: terminal.rows
  })
}

function summarizeTerminalMutation(result: TerminalMutationSuccess): string {
  return JSON.stringify({ ok: result.ok })
}
