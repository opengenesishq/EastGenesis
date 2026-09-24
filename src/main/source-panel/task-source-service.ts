import { randomUUID } from 'node:crypto'
import type { SessionMeta, TranscriptEntry } from '../../shared/types'
import type { StudioResultArtifact, StudioResultEvidence, StudioResultRun } from '../../shared/studio-result-types'
import type { TaskSourceCollection, TaskSourceDetail } from '../../shared/task-source-types'
import { sourceContentHash, sourceDigest, taskAttachmentSources, verifiedSourcePreview, type SourceFile } from './task-source-files'

type SourceMeta = Pick<SessionMeta, 'id' | 'createdAt' | 'cwd' | 'sourceCwd' | 'taskMemorySessionId' | 'sdkSessionId' | 'workspaceId' | 'projectId' | 'goalId' | 'workItemId' | 'status'>
export interface TaskSourceContext { meta: SourceMeta; transcript: TranscriptEntry[]; artifacts: StudioResultArtifact[]; evidence: StudioResultEvidence[]; runs: StudioResultRun[]; warnings?: string[] }
interface Source extends SourceFile { artifact?: StudioResultArtifact; evidence?: StudioResultEvidence }
interface Collection { owner: number; sessionId: string; taskKey: string; sources: Source[]; expiresAt: number }
export const taskSourceKey = (meta: SourceMeta): string => sourceDigest([meta.id, meta.createdAt, meta.cwd, meta.sourceCwd, meta.taskMemorySessionId, meta.sdkSessionId, meta.workspaceId, meta.projectId, meta.goalId, meta.workItemId])

export class TaskSourceService {
  private readonly collections = new Map<string, Collection>()
  private readonly releasedOwners = new Set<number>()
  constructor(private readonly root: string, private readonly load: (sessionId: string) => Promise<TaskSourceContext>, private readonly now = Date.now) {}
  async list(owner: number, sessionId: string): Promise<TaskSourceCollection> {
    const context = await this.live(sessionId), attachment = await taskAttachmentSources(this.root, sessionId, context.transcript)
    const sources = [...attachment.sources, ...registeredSources(context)], taskKey = taskSourceKey(context.meta)
    await this.checkTask(context, sessionId)
    if (this.releasedOwners.has(owner)) throw new Error('资料窗口已关闭。')
    for (const [id, value] of this.collections) if (value.expiresAt <= this.now()) this.collections.delete(id)
    const owned = [...this.collections].filter(([, value]) => value.owner === owner)
    for (const [id] of owned.slice(0, Math.max(0, owned.length - 15))) this.collections.delete(id)
    const collectionId = randomUUID()
    this.collections.set(collectionId, { owner, sessionId, taskKey, sources: sources.slice(0, 1000), expiresAt: this.now() + 600_000 })
    return { collectionId, sessionId, taskKey, items: sources.slice(0, 1000).map(source => source.item),
      warnings: [...context.warnings ?? [], ...attachment.warnings, ...(sources.length > 1000 ? ['资料较多，此处最多显示 1000 项。'] : [])],
      memory: { task: true, project: Boolean(context.meta.workspaceId || context.meta.sourceCwd || context.meta.cwd) } }
  }
  async read(owner: number, sessionId: string, collectionId: string, sourceId: string): Promise<TaskSourceDetail> {
    const { source, context } = await this.current(owner, sessionId, collectionId, sourceId)
    const preview = source.path && !source.item.unavailableReason ? await verifiedSourcePreview(source) : undefined
    // Revalidate source metadata after asynchronous disk/Office processing as well.
    await this.current(owner, sessionId, collectionId, sourceId)
    await this.checkTask(context, sessionId)
    return { item: source.item, preview, artifact: source.artifact, evidence: source.evidence }
  }
  async url(owner: number, sessionId: string, collectionId: string, sourceId: string): Promise<string> {
    const { source } = await this.current(owner, sessionId, collectionId, sourceId)
    const url = safeRecordedUrl(source.evidence?.sourceUri)
    if (!url) throw new Error('这条资料未登记可打开的网页来源。')
    return url
  }
  releaseOwner(owner: number): void {
    this.releasedOwners.add(owner)
    for (const [id, value] of this.collections) if (value.owner === owner) this.collections.delete(id)
  }
  private async live(sessionId: string): Promise<TaskSourceContext> {
    const context = await this.load(sessionId)
    if (context.meta.id !== sessionId || context.meta.status === 'closed') throw new Error('原任务已关闭或不存在。')
    return context
  }
  private async checkTask(before: TaskSourceContext, sessionId: string): Promise<void> {
    const current = await this.live(sessionId)
    if (taskSourceKey(before.meta) !== taskSourceKey(current.meta)) throw new Error('读取资料期间任务归属已变化，请刷新。')
  }
  private async current(owner: number, sessionId: string, collectionId: string, sourceId: string) {
    const collection = this.collections.get(collectionId)
    if (!collection || collection.owner !== owner || collection.sessionId !== sessionId || collection.expiresAt <= this.now() || this.releasedOwners.has(owner)) throw new Error('资料集合已过期或不属于此任务窗口，请刷新。')
    const context = await this.live(sessionId)
    if (taskSourceKey(context.meta) !== collection.taskKey) throw new Error('原任务归属已变化，请重新打开资料。')
    const frozen = collection.sources.find(source => source.item.id === sourceId)
    if (!frozen) throw new Error('资料不属于此任务集合。')
    const sources = frozen.item.kind === 'attachment' ? (await taskAttachmentSources(this.root, sessionId, context.transcript)).sources : registeredSources(context)
    const source = sources.find(value => value.item.id === sourceId) as Source | undefined
    if (!source || sourceDigest(source) !== sourceDigest(frozen)) throw new Error('资料来源或版本已变化，请刷新。')
    await this.checkTask(context, sessionId)
    if (this.releasedOwners.has(owner) || !this.collections.has(collectionId)) throw new Error('资料窗口已关闭。')
    return { source, context }
  }
}

function safeRecordedUrl(raw?: string): string | undefined {
  if (!raw) return undefined
  try { const url = new URL(raw); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}
/** Scope may contain a project aggregate: require exact Session Run or canonical WorkItem. */
export function registeredSources(context: TaskSourceContext): Source[] {
  const runs = new Set(context.runs.filter(run => run.sessionId === context.meta.id || Boolean(context.meta.workItemId && run.workItemId === context.meta.workItemId)).map(run => run.id))
  const artifacts = context.artifacts.filter(artifact => Boolean(artifact.runId && runs.has(artifact.runId)) || Boolean(context.meta.workItemId && artifact.workItemId === context.meta.workItemId))
  const artifactIds = new Set(artifacts.map(artifact => artifact.id)), result: Source[] = []
  for (const artifact of artifacts) {
    const location = artifact.locations.find(value => value.availability === 'available' && value.path && ['workspace_file', 'artifact_store', 'local_file'].includes(value.kind))
    const id = sourceDigest(['artifact', artifact.id, artifact.version, artifact.digest, location?.id, location?.path])
    const unavailableReason = !location?.path ? '成果没有可用的本地文件。' : !sourceContentHash(artifact.digest) ? '成果缺少可核对的内容摘要。'
      : location.checksum && sourceContentHash(location.checksum) !== sourceContentHash(artifact.digest) ? '成果位置与版本摘要不一致。' : undefined
    result.push({ path: location?.path, artifact, item: { id, kind: 'artifact', provenance: 'registered_artifact', artifactId: artifact.id,
      title: artifact.title, digest: artifact.digest, version: artifact.version, mime: artifact.mediaType ?? location?.mediaType,
      bytes: location?.sizeBytes, unavailableReason, historical: artifact.deliveryScope === 'historical' } })
  }
  for (const raw of context.evidence) {
    if (raw.kind !== 'research_source' || raw.origin !== 'workflow') continue
    if (!(raw.runId && runs.has(raw.runId)) && !(raw.artifactId && artifactIds.has(raw.artifactId))) continue
    const evidence = { ...raw, sourceUri: safeRecordedUrl(raw.sourceUri) }, id = sourceDigest(['research', evidence.id, evidence.contentDigest, evidence.observedAt])
    result.push({ evidence, item: { id, kind: 'research', provenance: 'registered_source', title: evidence.title,
      evidenceId: evidence.id, digest: evidence.contentDigest, sourceContentKind: evidence.sourceContentKind } })
  }
  return result
}
