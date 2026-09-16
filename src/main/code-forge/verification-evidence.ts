import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { CommandTermination, TaskRunRecord, TranscriptEntry } from '../../shared/types'
import type { CodeForgeVerificationCommandResult, CodeForgeVerificationSummary } from './delivery'
import { writeDurableFileSync } from '../durable-file'
import { stableValueDigest } from '../task/tool-idempotency'
import { effectRecordIntegrityMatches } from '../task/effect-record-integrity'
import { observeCodeForgeSourceVersion, type CodeForgeSourceVersion } from './verification-source'

interface ExecutionBinding { rootDir: string; sessionId: string; runId: string; toolUseId: string }
interface CommandResult { ok: boolean; output: string; exitCode?: number; commandTermination?: CommandTermination }
interface VerificationReceipt {
  schemaVersion: 1
  sessionId: string; runId: string; toolUseId: string
  inputDigest: string; outputDigest: string; commandDigest: string
  before: CodeForgeSourceVersion; after: CodeForgeSourceVersion
  startedAt: number; completedAt: number
  ok: boolean; exitCode?: number; commandTermination?: CommandTermination
  digest: string
}
export interface CodeForgeVerificationCapture extends ExecutionBinding {
  inputDigest: string; commandDigest: string; before: CodeForgeSourceVersion; startedAt: number
}
export interface CodeForgeVerificationContext {
  rootDir: string
  run: TaskRunRecord
  transcript: readonly TranscriptEntry[]
}

export function codeForgeVerificationDirectory(rootDir: string, sessionId: string): string {
  return join(rootDir, 'code-forge-verifications', stableValueDigest(sessionId))
}
function receiptFile(input: ExecutionBinding): string {
  return join(codeForgeVerificationDirectory(input.rootDir, input.sessionId), `${stableValueDigest({ runId: input.runId, toolUseId: input.toolUseId })}.json`)
}

/** Only main's native executor creates this receipt. No command/output plaintext is copied. */
export function beginCodeForgeVerification(input: ExecutionBinding, cwd: string, args: Record<string, unknown>): CodeForgeVerificationCapture {
  if (!input.sessionId || !input.runId || !input.toolUseId || args.recordVerification !== true || typeof args.command !== 'string') throw new Error('验证记录缺少原生 Run 身份')
  assertReceiptPath(input, false)
  return { ...input, inputDigest: stableValueDigest(args), commandDigest: stableValueDigest(args.command), before: observeCodeForgeSourceVersion(cwd), startedAt: Date.now() }
}
export function finishCodeForgeVerification(capture: CodeForgeVerificationCapture, result: CommandResult): void {
  const after = observeCodeForgeSourceVersion(capture.before.cwd)
  const { rootDir: _root, ...binding } = capture
  const body = { schemaVersion: 1 as const, ...binding, after, completedAt: Date.now(), ok: result.ok,
    outputDigest: stableValueDigest(result.output), exitCode: result.exitCode, commandTermination: result.commandTermination }
  const serializable = JSON.parse(JSON.stringify(body)) as Omit<VerificationReceipt, 'digest'>
  const file = assertReceiptPath(capture, true)
  try { lstatSync(file); throw new Error('此工具调用已有冻结验证记录，不能覆盖') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  writeDurableFileSync(file, JSON.stringify({ ...serializable, digest: stableValueDigest(serializable) }))
}

/** Missing/stale records explain a skipped result; shell stdout can never create a passed receipt. */
export function collectCodeForgeVerification(
  ids: readonly string[] | undefined, cwd: string, sessionId: string | undefined, context?: CodeForgeVerificationContext
): CodeForgeVerificationSummary {
  if (!ids?.length) return { status: 'skipped', commands: [], passed: 0, failed: 0, skipped: 1,
    scope: '仅引用选定原生命令；未选择验证记录，不代表任务验收。' }
  if (ids.length > 20 || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string' || !id.trim())) throw new Error('verificationToolUseIds 须为至多 20 个不重复的真实工具调用 ID')
  let source: CodeForgeSourceVersion | undefined, sourceError: string | undefined
  try { source = observeCodeForgeSourceVersion(cwd) } catch (error) { sourceError = message(error) }
  const commands = ids.map((toolUseId): CodeForgeVerificationCommandResult => {
    const result: CodeForgeVerificationCommandResult = { toolUseId, command: '', cwd, status: 'skipped', exitCode: null, durationMs: 0, output: '' }
    try {
      if (!context || !sessionId || context.run.sessionId !== sessionId) throw new Error('当前 Run 没有可核对的持久执行上下文')
      const { run, transcript } = context
      const executions = (run.toolExecutions ?? []).filter((entry) => entry.toolUseId === toolUseId)
      if (executions.length !== 1) throw new Error('所选调用不属于当前 Run，或执行身份不唯一')
      const execution = executions[0]
      result.runId = run.id; result.executionId = execution.id
      if (execution.runId !== run.id || execution.sessionId !== sessionId || execution.toolName !== 'bash' ||
          !['succeeded', 'failed', 'unknown_outcome'].includes(execution.status) || !execution.finishedAt || execution.supersededByExecutionId) throw new Error('所选命令尚未完成，或已被替代')
      const requests = transcript.filter((entry) => entry.eventId === execution.requestedEventId && entry.event.kind === 'assistant-message')
      const results = transcript.filter((entry) => entry.eventId === execution.resultEventId && entry.event.kind === 'tool-result')
      if (requests.length !== 1 || results.length !== 1 || requests[0].seq >= results[0].seq) throw new Error('原始请求或结果事件缺失/不唯一')
      const requestEvent = requests[0].event, resultEvent = results[0].event
      if (requestEvent.kind !== 'assistant-message' || resultEvent.kind !== 'tool-result' || resultEvent.toolUseId !== toolUseId) throw new Error('原始事件身份不匹配')
      const blocks = requestEvent.blocks.filter((block) => block.type === 'tool_use' && block.id === toolUseId)
      const block = blocks[0]
      if (blocks.length !== 1 || block.type !== 'tool_use' || block.name !== 'bash' || !isRecord(block.input) || typeof block.input.command !== 'string' ||
          execution.inputDigest !== stableValueDigest(block.input) || execution.outputDigest !== stableValueDigest(resultEvent.content)) throw new Error('命令或结果摘要与执行记录不匹配')
      result.command = block.input.command; result.output = resultEvent.content; result.resultEventId = execution.resultEventId
      result.exitCode = resultEvent.exitCode ?? null
      if (block.input.recordVerification !== true) throw new Error('历史命令没有冻结源码版本；需显式 bash recordVerification=true 生成新证据')
      const receipt = readReceipt({ ...context, sessionId, runId: run.id, toolUseId })
      if (!receipt) throw new Error('主进程验证记录缺失；日志文本不能替代验证证据')
      if (receipt.inputDigest !== execution.inputDigest || receipt.outputDigest !== execution.outputDigest || receipt.commandDigest !== stableValueDigest(block.input.command) ||
          receipt.exitCode !== resultEvent.exitCode || receipt.commandTermination !== resultEvent.commandTermination || receipt.ok !== !Boolean(resultEvent.isError)) throw new Error('冻结验证记录与真实执行结果不匹配')
      result.cwd = receipt.before.cwd; result.durationMs = receipt.completedAt - receipt.startedAt
      result.sourceVersion = receipt.after; result.evidenceDigest = receipt.digest
      if (receipt.commandTermination === 'exited' && Number.isSafeInteger(receipt.exitCode) && receipt.exitCode !== 0) result.status = 'failed'
      if (execution.effectId) {
        const effect = run.effects?.find((entry) => entry.id === execution.effectId)
        if (!effect || effect.runId !== run.id || effect.sessionId !== sessionId || effect.toolUseId !== toolUseId ||
            effect.inputDigest !== execution.inputDigest || !effectRecordIntegrityMatches(effect) ||
            !['confirmed', 'failed'].includes(effect.status) || !effect.evidence.some((entry) => entry.kind === 'execution_result')) throw new Error('Effect 未确认真实终态，或证据不完整')
        result.effectId = effect.id; result.effectEvidenceIds = effect.evidence.filter((entry) => entry.kind === 'execution_result').map((entry) => entry.id)
        if (effect.status === 'failed' && !resultEvent.isError) throw new Error('Effect 失败状态与结果冲突')
      }
      if (receipt.commandTermination !== 'exited' || !Number.isSafeInteger(receipt.exitCode)) throw new Error('命令没有明确退出；超时、中断和未知结果不能标为通过')
      if (execution.status === 'unknown_outcome') throw new Error('命令已有退出记录，但外部 Effect 仍待对账，不能标为通过')
      if (!source) throw new Error(sourceError ?? '当前源码版本无法核对')
      if (stableValueDigest(receipt.before) !== stableValueDigest(receipt.after) || stableValueDigest(receipt.after) !== stableValueDigest(source)) throw new Error('验证前后或当前源码/cwd 已变化，所选结果不适用于此版本')
      result.status = receipt.ok && receipt.exitCode === 0 && execution.status === 'succeeded' ? 'passed' : 'failed'
      result.reason = result.status === 'passed' ? '命令正常退出且验证前后与当前源码版本一致；只证明此命令结果。' : '所选命令在此源码版本执行失败。'
    } catch (error) { result.reason = message(error) }
    return result
  })
  const passed = commands.filter((entry) => entry.status === 'passed').length
  const failed = commands.filter((entry) => entry.status === 'failed').length
  const skipped = commands.length - passed - failed
  return { status: failed ? 'failed' : skipped ? 'skipped' : 'passed', commands, passed, failed, skipped,
    scope: '选定命令的结构化结果；源码包含 tracked 与未忽略 untracked 文件，不含忽略文件、外部依赖或任务验收。' }
}

function readReceipt(input: ExecutionBinding): VerificationReceipt | undefined {
  const file = assertReceiptPath(input, false)
  let raw: string
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768) throw new Error('验证记录不是安全的普通文件')
    raw = readFileSync(file, 'utf8')
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  const record = JSON.parse(raw) as VerificationReceipt
  const { digest, ...body } = record
  if (record.schemaVersion !== 1 || record.sessionId !== input.sessionId || record.runId !== input.runId || record.toolUseId !== input.toolUseId ||
      !isRecord(record.before) || !isRecord(record.after) || digest !== stableValueDigest(body) ||
      !Number.isFinite(record.startedAt) || !Number.isFinite(record.completedAt) || record.completedAt < record.startedAt) throw new Error('验证记录损坏或所属身份不匹配')
  return record
}
function assertReceiptPath(input: ExecutionBinding, create: boolean): string {
  const root = realpathSync(resolve(input.rootDir)), file = receiptFile({ ...input, rootDir: root })
  for (const directory of [join(root, 'code-forge-verifications'), dirname(file)]) {
    try { const stat = lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('验证记录目录不是安全的普通目录') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; if (create) mkdirSync(directory, { mode: 0o700 }) }
  }
  return file
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
