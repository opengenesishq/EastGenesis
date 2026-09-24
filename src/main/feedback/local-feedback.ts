import { randomUUID } from 'node:crypto'
import type { FeedbackAppInfo, FeedbackExportResult, FeedbackPreview, FeedbackPreviewInput } from '../../shared/feedback-types'
import type { SessionMeta, TaskRunRecord } from '../../shared/types'
import { redactSensitiveText } from '../security/secret-redaction'

const PREVIEW_LIFETIME_MS = 15 * 60_000
const RUN_STATUSES = ['queued', 'planning', 'executing', 'waiting_approval', 'waiting_reconciliation', 'verifying', 'recovering', 'completed', 'failed', 'cancelled'] as const

interface FeedbackDependencies {
  appInfo(): FeedbackAppInfo
  session(id: string): SessionMeta | undefined
  run(id: string): TaskRunRecord | undefined
  now?(): number
}

/** A reviewed report is held only in memory, scoped to its trusted window. */
export class LocalFeedbackService {
  private readonly previews = new Map<number, FeedbackPreview>()
  private readonly exporting = new Set<number>()
  constructor(private readonly dependencies: FeedbackDependencies) {}

  appInfo(): FeedbackAppInfo {
    const info = this.dependencies.appInfo()
    // Enumerate every field; never include environment variables or arbitrary runtime properties.
    return { name: 'EastGenesis', version: safeVersion(info.version), platform: enumValue(info.platform, ['darwin', 'win32', 'linux']),
      architecture: enumValue(info.architecture, ['arm64', 'x64', 'ia32', 'arm', 'riscv64']),
      build: info.build === 'packaged' ? 'packaged' : 'development', electron: safeVersion(info.electron), chromium: safeVersion(info.chromium), node: safeVersion(info.node) }
  }

  preview(owner: number, raw: unknown): FeedbackPreview {
    const input = parseInput(raw)
    const wantsTask = input.includeTaskSummary || input.includeErrorSummary
    const session = wantsTask && input.sessionId ? this.dependencies.session(input.sessionId) : undefined
    if (wantsTask && !session) throw new Error('当前任务不可用，请取消任务摘要选项后重试。')
    const run = session && input.sessionId ? this.dependencies.run(input.sessionId) : undefined
    const generatedAt = this.now()
    const report = {
      schemaVersion: 1,
      generatedAt: new Date(generatedAt).toISOString(),
      description: redactSensitiveText(input.description.trim()),
      application: this.appInfo(),
      ...(input.includeTaskSummary && session ? { taskSummary: {
        status: enumValue(session.status, ['starting', 'running', 'idle', 'error', 'closed']),
        strategy: enumValue(session.taskStrategy, ['view', 'plan', 'execute']),
        engine: enumValue(session.engine, ['anthropic', 'gemini', 'openai']),
        routingScope: enumValue(session.routingScope, ['fixed', 'provider', 'global']),
        isolated: session.isolated === true,
        runStatus: enumValue(run?.status, RUN_STATUSES),
        attempt: safeCount(run?.attempt), recoveryCount: safeCount(run?.recoveryCount),
        stepCount: run?.steps?.length ?? 0, toolExecutionCount: run?.toolExecutions?.length ?? 0
      } } : {}),
      ...(input.includeErrorSummary && session ? { errorSummary: {
        scope: 'current-task-only', sessionInError: session.status === 'error',
        hasSessionError: Boolean(session.lastError), runFailed: run?.status === 'failed', hasRunError: Boolean(run?.error),
        failedSteps: run?.steps?.filter(step => step.status === 'failed').length ?? 0,
        failedToolExecutions: run?.toolExecutions?.filter(tool => tool.status === 'failed').length ?? 0,
        unknownToolOutcomes: run?.toolExecutions?.filter(tool => tool.status === 'unknown_outcome').length ?? 0
      } } : {})
    }
    const preview: FeedbackPreview = { previewId: randomUUID(), generatedAt, expiresAt: generatedAt + PREVIEW_LIFETIME_MS, json: `${JSON.stringify(report, null, 2)}\n` }
    this.previews.set(owner, preview)
    return { ...preview }
  }

  async export(owner: number, previewId: unknown, ports: {
    choosePath(filename: string): Promise<string | undefined>
    assertOwner(): void
    write(path: string, json: string): Promise<void>
  }): Promise<FeedbackExportResult> {
    const preview = this.requirePreview(owner, previewId)
    if (this.exporting.has(owner)) throw new Error('本窗口已有导出正在进行。')
    this.exporting.add(owner)
    try {
      const path = await ports.choosePath(`caogen-feedback-${new Date(preview.generatedAt).toISOString().slice(0, 10)}.json`)
      if (!path) return { canceled: true }
      ports.assertOwner()
      if (this.requirePreview(owner, previewId) !== preview) throw new Error('反馈预览已改变，请重新查看后导出。')
      await ports.write(path, preview.json)
      return { canceled: false, filePath: path }
    } finally { this.exporting.delete(owner) }
  }

  clearOwner(owner: number): void { this.previews.delete(owner) }
  private now(): number { return this.dependencies.now?.() ?? Date.now() }
  private requirePreview(owner: number, id: unknown): FeedbackPreview {
    const preview = this.previews.get(owner)
    if (typeof id !== 'string' || !preview || id !== preview.previewId || preview.expiresAt <= this.now()) {
      throw new Error('反馈预览不存在或已过期，请重新生成。')
    }
    return preview
  }
}

function parseInput(raw: unknown): FeedbackPreviewInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('反馈参数无效。')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some(key => !['description', 'includeTaskSummary', 'includeErrorSummary', 'sessionId'].includes(key)) ||
      typeof value.description !== 'string' || !value.description.trim() || value.description.length > 12_000 ||
      typeof value.includeTaskSummary !== 'boolean' || typeof value.includeErrorSummary !== 'boolean' ||
      (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || value.sessionId.length > 256))) {
    throw new Error('请填写 1–12000 字的问题描述，并使用有效的摘要选项。')
  }
  return { description: value.description, includeTaskSummary: value.includeTaskSummary, includeErrorSummary: value.includeErrorSummary,
    ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}) }
}

function safeVersion(value: unknown): string { return typeof value === 'string' && /^[0-9][0-9A-Za-z.+-]{0,79}$/.test(value) ? value : 'unknown' }
function enumValue(value: unknown, allowed: readonly string[]): string { return typeof value === 'string' && allowed.includes(value) ? value : 'unknown' }
function safeCount(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0 }
