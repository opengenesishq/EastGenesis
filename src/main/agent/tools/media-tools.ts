import type { SessionMeta } from '../../../shared/types'
import type { MediaJobRecord, VideoProduction } from '../../../shared/media-types'
import type { ToolExecResult } from './tool-types'
import { getMediaRuntime } from '../../media/media-runtime'
import { assertMediaAgentOwnership, mediaAgentOrigin, validateMediaAgentMutation, type MediaAgentExecutionContext } from '../../media/media-agent-context'
import { assertMediaToolKeys, mediaToolIdentity, mediaToolSubmission, mediaToolText } from './media-tool-input'
import { isMediaToolName } from '../../../shared/media-tool-contract'
export { isMediaToolName } from '../../../shared/media-tool-contract'
export { MEDIA_TOOLS } from './media-tool-definitions'

export async function executeMediaTool(name: string, args: Record<string, unknown>, input: {
  sessionMeta?: SessionMeta; userDataRoot?: string; toolUseId?: string; signal?: AbortSignal
}): Promise<ToolExecResult> {
  if (!isMediaToolName(name)) throw new Error('Unknown media tool')
  if (!input.sessionMeta || !input.userDataRoot || !input.toolUseId) throw new Error('Media tool requires its native session context')
  if (input.signal?.aborted) throw new Error('媒体操作已中断，未提交')
  const context: MediaAgentExecutionContext = { meta: input.sessionMeta, rootDir: input.userDataRoot, toolUseId: input.toolUseId }
  if (name === 'inspect_media') return jsonResult(await inspectMedia(args, context))
  const origin = await validateMediaAgentMutation(context)
  const runtime = getMediaRuntime(context.rootDir)
  if (name === 'create_video_production') {
    assertMediaToolKeys(args, ['title', 'script'])
    const production = await runtime.createVideoProduction({ id: mediaToolIdentity(origin, 'production'),
      projectId: origin.workspaceId, businessLineId: origin.businessLineId,
      title: mediaToolText(args.title, 'title'), script: mediaToolText(args.script, 'script', 20000), autoStructure: true })
    return jsonResult(productionView(production))
  }
  if (name === 'submit_media_job') {
    const submission = mediaToolSubmission(args, origin)
    const production = (await runtime.getMediaStudio(origin.workspaceId)).productions.find((item) => item.id === submission.productionId)
    if (!production) throw new Error('Media Production was not found in the current Project')
    assertMediaAgentOwnership(origin, production)
    return jsonResult(jobView(await runtime.submitMediaJob(submission, context)))
  }
  assertMediaToolKeys(args, ['jobId'])
  const id = mediaToolText(args.jobId, 'jobId')
  const job = (await runtime.getMediaStudio(origin.workspaceId)).jobs.find((item) => item.id === id)
  if (!job) throw new Error('MediaJob was not found in the current Project')
  assertMediaAgentOwnership(origin, job)
  return jsonResult(jobView(await (name === 'reconcile_media_job' ? runtime.reconcileMediaJob(id) : runtime.advanceMediaJob(id))))
}

async function inspectMedia(args: Record<string, unknown>, context: MediaAgentExecutionContext) {
  assertMediaToolKeys(args, ['productionId', 'limit'])
  const limit = args.limit ?? 8
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 20) throw new Error('Media inspection limit must be between 1 and 20')
  const runtime = getMediaRuntime(context.rootDir)
  const targets = (await runtime.listMediaProviders()).map((item) => ({ id: item.id, name: item.displayName,
    capabilities: item.capabilities, operations: item.operations, enabled: item.enabled, model: item.model,
    pricing: item.mediaPricing, fixedRequestEstimateUsd: item.estimatedCostUsd, source: item.source }))
  if (!context.meta.workspaceId || context.meta.unassigned) return { targets, projectBindingRequired: true,
    nextStep: '在项目中创建或打开工作区，然后在该项目创建任务。媒体工具不能由参数指定任意项目。' }
  const origin = mediaAgentOrigin(context)
  const snapshot = await runtime.getMediaStudio(origin.workspaceId)
  const productionId = args.productionId === undefined ? undefined : mediaToolText(args.productionId, 'productionId')
  const productions = snapshot.productions.filter((item) => (item.businessLineId ?? 'video') === origin.businessLineId && (!productionId || item.id === productionId))
  if (productionId && productions.length === 0) throw new Error('Production is outside the current Project/business line')
  const ids = new Set(productions.map((item) => item.id))
  return { targets, projectId: origin.workspaceId, businessLineId: origin.businessLineId,
    productions: productions.slice(0, Number(limit)).map(productionView),
    jobs: snapshot.jobs.filter((item) => ids.has(item.productionId)).slice(-Number(limit)).map(jobView) }
}

function productionView(production: VideoProduction) {
  return { id: production.id, title: production.title, businessLineId: production.businessLineId, revision: production.revision,
    budget: production.budget,
    shots: production.shots.slice(-64).map((shot) => ({ id: shot.id, title: shot.title, prompt: shot.prompt, durationMs: shot.durationMs })),
    assets: production.assets.slice(-64).map((asset) => ({ id: asset.id, artifactId: asset.artifactId, kind: asset.kind,
      digest: asset.digest, previewUrl: asset.previewUrl, adopted: asset.adopted })) }
}
function jobView(job: MediaJobRecord) {
  return { id: job.id, productionId: job.productionId, businessLineId: job.businessLineId, status: job.status,
    operation: job.operation, providerId: job.providerId, mediaProviderId: job.mediaProviderId, model: job.model,
    route: job.executionBinding?.decision, cost: job.cost, error: job.error,
    output: job.output ? { artifactId: job.output.artifactId, digest: job.output.digest, mediaType: job.output.mediaType,
      previewUrl: job.output.artifactId ? `caogen-media://artifact/${encodeURIComponent(job.output.artifactId)}` : undefined } : undefined,
    nextStep: job.status === 'waiting_reconciliation' ? '使用 reconcile_media_job 查询原任务；不能换目标或重新提交。'
      : ['succeeded', 'failed', 'cancelled'].includes(job.status) ? '任务已结束；产物和费用见当前记录。' : '可使用 advance_media_job 推进一步。' }
}
function jsonResult(value: unknown): ToolExecResult { return { ok: true, output: JSON.stringify(value) } }
