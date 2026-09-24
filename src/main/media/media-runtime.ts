import { mediaTarget, binding, outputIdentities, localOutputIdentities, operationIdFor, bindingDigest } from './media-operation-identity'
import { mediaRequestBudgetScope, withMediaRequestBudget, reconcileMediaRequestBudget } from './media-request-budget'
import { mediaAgentOrigin, type MediaAgentExecutionContext } from './media-agent-context'
import { localMediaCost as nonBillableMediaCost } from './media-cost'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import type {
  MediaAdoptionInput,
  MediaApi,
  MediaAsset,
  MediaAssetBinding,
  MediaAssetBindingInput,
  MediaAssetImportInput,
  MediaAssetPurgeInput,
  MediaAssetPurgeResult,
  MediaAssetRetentionUpdateInput,
  MediaAssetEgressInput,
  MediaVoiceCloneAuthorizationInput,
  MediaBudgetUpdateInput,
  MediaCharacterBible,
  MediaCharacterBibleDeleteInput,
  MediaCharacterBibleInput,
  MediaCompositionInput,
  MediaCompositionResult,
  MediaContinuityCheckInput,
  MediaContinuityCheckResult,
  MediaContinuityFinding,
  MediaContinuityLock,
  MediaContinuityLockDeleteInput,
  MediaContinuityLockInput,
  MediaDialogueCue,
  MediaDialogueCueDeleteInput,
  MediaDialogueCueInput,
  MediaFfmpegInfo,
  MediaJobInput,
  MediaJobOutput,
  MediaJobRecord,
  MediaProductionInput,
  MediaProductionRevisionInput,
  MediaProjectStorageSettings,
  MediaProjectStorageUpdateInput,
  MediaProviderProfile,
  MediaProviderProfileDeleteInput,
  MediaProviderProfileInput,
  MediaShotInput,
  MediaShotUpdateInput,
  MediaStudioSnapshot,
  MediaTimelineUpdateInput,
  VideoProduction,
  VideoShot
} from '../../shared/media-types'
import { MEDIA_SCHEMA_VERSION } from '../../shared/media-types'
import type { EffectRecord } from '../../shared/types'
import { registerCanonicalProducedArtifact } from '../task/artifact-production-boundary'
import {
  getPersistedArtifactLifecycle,
  purgePersistedArtifactContent,
  revisePersistedArtifactRetention
} from '../task/artifact-lifecycle-api'
import { assertDataPurgeAllowed } from '../data-lifecycle/retention-authority'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { createPersistedWorkflowArtifactEdge } from '../task/workflow-ledger-artifact-graph-api'
import { executeInteractiveOperationEffect } from '../task/operation-effect-gateway'
import {
  prepareCanonicalSystemOperation,
  type CanonicalSystemOperationContext
} from '../task/system-operation-context'
import { TaskKernel } from '../task/task-kernel'
import { stableValueDigest } from '../task/tool-idempotency'
import type { MediaJobOperationTarget } from './media-job-effect-target'
import { executeRemoteMediaOperation } from './media-provider-runtime'
import { bindMediaJobBusinessLine, createBusinessLineProduction, replayMediaJobBusinessLine } from './media-business-line'
import { missingMediaReconciliationIdentity, observedMediaProviderJobId } from './media-reconciliation-identity'
import { reconcileMediaOperationEffects, settleTerminal } from './media-reconcile-effects'
import { nextTransition, isTerminal } from './media-job-transition'
import { withMediaJobOperationQueue } from './media-job-operation-queue'
import { mediaJobIdForKey } from './media-submission-identity'
import { mediaProfileForJob, prepareMediaRoute, runtimeMediaProviders, runtimeMediaStudio } from './media-routing-runtime'
import { buildMinimalSubprocessEnv } from '../security/subprocess-environment'
import {
  getMediaStore,
  type MediaJobCanonicalBinding,
  type MediaJobOperationCommit
} from './media-store'
import {
  composeProductionDraft,
  ffmpegPath,
  importMediaFile,
  inspectBundledFfmpeg,
  type MediaCompositionManifest
} from './media-ffmpeg'

const execFileAsync = promisify(execFile)

export class MediaRuntime implements MediaApi {
  constructor(private readonly rootDir: string) {}

  getMediaStudio(projectId?: string): Promise<MediaStudioSnapshot> {
    return runtimeMediaStudio(getMediaStore(this.rootDir), projectId)
  }

  listMediaProviders(): Promise<MediaProviderProfile[]> {
    return runtimeMediaProviders(getMediaStore(this.rootDir))
  }

  upsertMediaProvider(input: MediaProviderProfileInput): Promise<MediaProviderProfile> {
    return getMediaStore(this.rootDir).upsertMediaProvider(input)
  }

  deleteMediaProvider(input: MediaProviderProfileDeleteInput): Promise<void> {
    return getMediaStore(this.rootDir).deleteMediaProvider(input)
  }

  getMediaFfmpegInfo(): Promise<MediaFfmpegInfo> {
    return inspectBundledFfmpeg()
  }

  createVideoProduction(input: MediaProductionInput): Promise<VideoProduction> {
    return createBusinessLineProduction(getMediaStore(this.rootDir), input, this.rootDir)
  }

  reviseVideoProduction(input: MediaProductionRevisionInput): Promise<VideoProduction> {
    return getMediaStore(this.rootDir).reviseVideoProduction(input)
  }

  addVideoShot(input: MediaShotInput): Promise<VideoShot> {
    return getMediaStore(this.rootDir).addVideoShot(input)
  }

  updateVideoShot(input: MediaShotUpdateInput): Promise<VideoShot> {
    return getMediaStore(this.rootDir).updateVideoShot(input)
  }

  upsertMediaDialogueCue(input: MediaDialogueCueInput): Promise<MediaDialogueCue> {
    return getMediaStore(this.rootDir).upsertMediaDialogueCue(input)
  }

  deleteMediaDialogueCue(input: MediaDialogueCueDeleteInput): Promise<VideoShot> {
    return getMediaStore(this.rootDir).deleteMediaDialogueCue(input)
  }

  updateMediaTimeline(input: MediaTimelineUpdateInput): Promise<VideoProduction> {
    return getMediaStore(this.rootDir).updateMediaTimeline(input)
  }

  updateMediaBudget(input: MediaBudgetUpdateInput): Promise<VideoProduction> {
    return getMediaStore(this.rootDir).updateMediaBudget(input)
  }

  updateMediaProjectStorage(input: MediaProjectStorageUpdateInput): Promise<MediaProjectStorageSettings> {
    return getMediaStore(this.rootDir).updateMediaProjectStorage(input)
  }

  async updateMediaAssetRetention(input: MediaAssetRetentionUpdateInput): Promise<MediaAsset> {
    const store = getMediaStore(this.rootDir)
    const production = (await store.getMediaStudio(input.projectId)).productions.find((item) => item.id === input.productionId)
    const asset = production?.assets.find((item) => item.id === input.assetId)
    if (!production || !asset?.artifactId) throw new Error('MediaAsset retention target is invalid')
    const policy = input.mode === 'expire'
      ? { mode: 'expire' as const, retainUntil: requiredRetentionExpiry(input.retainUntil) }
      : { mode: 'retain' as const }
    await revisePersistedArtifactRetention({
      artifactId: asset.artifactId,
      projectId: input.projectId,
      policy,
      reason: 'media-asset-retention-policy'
    }, this.rootDir)
    return store.updateMediaAssetRetention(input)
  }

  async setMediaAssetEgress(input: MediaAssetEgressInput): Promise<MediaAsset> {
    const store = getMediaStore(this.rootDir)
    return store.setMediaAssetEgress(input, (await runtimeMediaProviders(store)).find((profile) => profile.id === input.mediaProviderId))
  }

  setMediaVoiceCloneAuthorization(input: MediaVoiceCloneAuthorizationInput): Promise<MediaAsset> {
    return getMediaStore(this.rootDir).setMediaVoiceCloneAuthorization(input)
  }

  async purgeMediaAsset(input: MediaAssetPurgeInput): Promise<MediaAssetPurgeResult> {
    const store = getMediaStore(this.rootDir)
    const production = (await store.getMediaStudio(input.projectId)).productions.find((item) => item.id === input.productionId)
    const asset = production?.assets.find((item) => item.id === input.assetId)
    if (!production || !asset?.artifactId || !asset.retention.retainUntil) throw new Error('MediaAsset purge target is invalid')
    await store.markMediaAssetPurgePending({
      ...input,
      mode: 'expire',
      retainUntil: asset.retention.retainUntil
    })
    try {
      assertDataPurgeAllowed(this.rootDir, {
        targets: [{ subject: { kind: 'project', id: input.projectId }, retentionAnchorAt: asset.createdAt }]
      })
      const lifecycle = await getPersistedArtifactLifecycle(asset.artifactId, this.rootDir)
      if (!lifecycle?.sourceRef) throw new Error('MediaAsset canonical source is unavailable')
      await purgePersistedArtifactContent({
        artifactId: asset.artifactId,
        projectId: input.projectId,
        reason: 'media-asset-retention-expired'
      }, this.rootDir)
      const bytesRemoved = await removeManagedMediaSource(this.rootDir, input.projectId, lifecycle.sourceRef)
      const purgedAt = Date.now()
      const committed = await store.finishMediaAssetPurge({ ...input, purgedAt })
      return { asset: committed, artifactId: asset.artifactId, bytesRemoved, purgedAt }
    } catch (error) {
      await store.failMediaAssetPurge({ ...input, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  upsertMediaCharacterBible(input: MediaCharacterBibleInput): Promise<MediaCharacterBible> {
    return getMediaStore(this.rootDir).upsertMediaCharacterBible(input)
  }

  deleteMediaCharacterBible(input: MediaCharacterBibleDeleteInput): Promise<VideoProduction> {
    return getMediaStore(this.rootDir).deleteMediaCharacterBible(input)
  }

  upsertMediaContinuityLock(input: MediaContinuityLockInput): Promise<MediaContinuityLock> {
    return getMediaStore(this.rootDir).upsertMediaContinuityLock(input)
  }

  deleteMediaContinuityLock(input: MediaContinuityLockDeleteInput): Promise<VideoProduction> {
    return getMediaStore(this.rootDir).deleteMediaContinuityLock(input)
  }

  async checkMediaContinuity(input: MediaContinuityCheckInput): Promise<MediaContinuityCheckResult> {
    const store = getMediaStore(this.rootDir)
    const production = (await store.getMediaStudio(input.projectId)).productions.find((item) => item.id === input.productionId)
    if (!production) throw new Error('Continuity Check Project/Production scope is invalid')
    const shotIds = input.shotIds?.length ? [...new Set(input.shotIds)] : adoptedProductionShotIds(production)
    if (shotIds.length === 0 || shotIds.some((shotId) => !production.shots.some((shot) => shot.id === shotId))) {
      throw new Error('Continuity Check needs Production-owned Shots')
    }
    const locks = production.continuityLocks.filter((lock) => lock.enabled && lock.targetShotIds.some((shotId) => shotIds.includes(shotId)))
    if (locks.length === 0) throw new Error('Continuity Check needs at least one enabled Lock')
    const findings = evaluateContinuity(production, shotIds, locks)
    const checkedAt = Date.now()
    const reportBody = {
      schemaVersion: 1,
      productionId: production.id,
      productionRevision: production.revision,
      checkedAt,
      passed: findings.every((finding) => finding.severity !== 'error'),
      shotIds,
      locks: locks.map((lock) => ({ id: lock.id, label: lock.label, bibleId: lock.bibleId, role: lock.role, assetId: lock.assetId, assetVersion: lock.assetVersion, targetShotIds: lock.targetShotIds })),
      characterBibles: production.characterBibles.filter((bible) => locks.some((lock) => lock.bibleId === bible.id)),
      findings
    }
    const bytes = Buffer.from(`${JSON.stringify(reportBody, null, 2)}\n`, 'utf8')
    const reportDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const identity = bindingDigest(`${production.id}\0${production.revision}\0${reportDigest}`)
    const context = await this.prepareJobContext(`continuity:${identity}`, production.title, production.projectId, production.businessLineId)
    const ids = localOutputIdentities('media-continuity', identity)
    const target = mediaTarget({
      context,
      operationId: `media-continuity-${identity}`,
      operation: 'continuity_check',
      mediaJobId: `media-continuity:${identity}`,
      externalJobId: `local-continuity:${identity}`,
      idempotencyKey: `media-continuity:${identity}`,
      expectedStatus: reportBody.passed ? 'succeeded' : 'failed',
      ...ids
    })
    const outcome = await executeInteractiveOperationEffect({
      rootDir: this.rootDir,
      operationId: target.runId.slice('operation:'.length),
      kind: 'media_generation',
      title: 'Check media continuity',
      sourceSessionId: `media:${target.mediaJobId}`,
      projectId: context.projectId,
      workspaceId: context.workspaceId,
      goalId: context.goalId,
      workItemId: context.workItemId,
      cwd: context.cwd,
      toolName: 'media_job_operation',
      toolInput: target,
      execute: async (effect) => {
        const persisted = await registerCanonicalProducedArtifact({
          lifecycle: {
            id: ids.artifactId!, projectId: context.projectId, goalId: context.goalId, workItemId: context.workItemId,
            runId: target.runId, lineageId: `lineage:media-continuity:${identity}`, kind: 'custom', title: `${production.title} continuity report`,
            version: 1, provenance: 'explicit', mediaType: 'application/vnd.caogen.media-continuity+json', retention: { mode: 'retain' },
            content: { storageKind: 'blob', bytes, expectedDigest: reportDigest },
            metadata: { producer: 'media-continuity-check', productionId: production.id, effectId: effect.id, findingCount: findings.length }
          },
          evidence: {
            id: ids.evidenceId!, kind: 'review_result', title: 'Media continuity result',
            summary: reportBody.passed ? 'All enabled continuity locks are satisfied.' : `${findings.length} continuity findings require repair.`,
            verifier: 'media-continuity-check', metadata: { reportDigest, findingCount: findings.length }
          },
          acceptance: {
            id: ids.acceptanceId!, criterionId: `${ids.acceptanceId}:criterion:continuity`,
            criterion: 'Every enabled continuity lock resolves to exactly one adopted binding with the frozen Asset version on each target Shot.',
            status: reportBody.passed ? 'passed' : 'failed', verifier: 'media-continuity-check', authorizesWorkflowStage: true
          }
        }, this.rootDir)
        const summary = {
          schemaVersion: MEDIA_SCHEMA_VERSION,
          id: `continuity-check:${identity}`,
          productionId: production.id,
          passed: reportBody.passed,
          checkedAt,
          shotIds,
          lockIds: locks.map((lock) => lock.id),
          findingCount: findings.length,
          digest: persisted.lifecycle.digest,
          artifactId: persisted.artifact.id,
          evidenceId: persisted.evidenceId,
          acceptanceId: persisted.acceptanceId!
        } as const
        await store.commitMediaContinuityCheck(production.id, summary)
        return { summary, findings }
      },
      isSuccess: () => true,
      resultSummary: (result) => JSON.stringify({ passed: result.summary.passed, findingCount: result.findings.length })
    })
    if (!outcome.value) throw new Error(outcome.status === 'failed' ? outcome.error : 'Continuity Check is waiting for reconciliation')
    await new TaskKernel(context.rootDir).deliver(context, {
      status: outcome.value.summary.passed ? 'passed' : 'failed', evidenceRefs: [outcome.value.summary.evidenceId], verifiedBy: 'media-continuity-check'
    })
    return outcome.value
  }

  async importMediaAsset(input: MediaAssetImportInput): Promise<MediaAsset | null> {
    if (!input.sourcePath) return null
    const store = getMediaStore(this.rootDir)
    const sourceState = await lstat(input.sourcePath)
    if (!sourceState.isFile() || sourceState.isSymbolicLink()) throw new Error('Media import source is invalid')
    await store.assertProjectStorageAvailable(input.projectId, sourceState.size)
    const production = (await store.getMediaStudio(input.projectId)).productions
      .find((item) => item.id === input.productionId)
    if (!production) throw new Error('MediaAsset Project/Production scope is invalid')
    const imported = await importMediaFile(input.sourcePath, this.rootDir, input.projectId, input.mediaType)
    const identity = bindingDigest(`${production.id}\0${imported.digest}\0${input.kind}`)
    const context = await this.prepareJobContext(`asset-import:${identity}`, production.title, production.projectId, production.businessLineId)
    const ids = localOutputIdentities('media-asset', identity)
    const target = mediaTarget({
      context,
      operationId: `media-asset-import-${identity}`,
      operation: 'asset_import',
      mediaJobId: `media-asset:${identity}`,
      externalJobId: `local-file:${identity}`,
      idempotencyKey: `media-asset:${identity}`,
      expectedStatus: 'succeeded',
      ...ids
    })
    const outcome = await executeInteractiveOperationEffect<MediaAsset>({
      rootDir: this.rootDir,
      operationId: target.runId.slice('operation:'.length),
      kind: 'media_generation',
      title: 'Import media asset',
      sourceSessionId: `media:${target.mediaJobId}`,
      projectId: context.projectId,
      workspaceId: context.workspaceId,
      goalId: context.goalId,
      workItemId: context.workItemId,
      cwd: context.cwd,
      toolName: 'media_job_operation',
      toolInput: target,
      execute: async (effect) => {
        const output = await persistLocalMediaArtifact({
          target,
          effect,
          rootDir: this.rootDir,
          sourcePath: imported.managedPath,
          digest: imported.digest,
          sizeBytes: imported.sizeBytes,
          mediaType: imported.mediaType,
          title: input.title?.trim() || imported.sourceFileName,
          producer: 'media-asset-import',
          metadata: { kind: input.kind, sourceFileName: imported.sourceFileName }
        })
        const asset: MediaAsset = {
          schemaVersion: MEDIA_SCHEMA_VERSION,
          id: `asset:${identity}`,
          productionId: production.id,
          kind: input.kind,
          title: (input.title?.trim() || imported.sourceFileName).slice(0, 240),
          version: nextAssetVersion(production.assets, input.kind, input.title || imported.sourceFileName),
          digest: output.digest,
          mediaType: output.mediaType,
          sizeBytes: output.sizeBytes,
          artifactId: output.artifactId,
          sourceFileName: imported.sourceFileName,
          adopted: false,
          authorization: { source: 'user_import', status: 'declared_by_user', dataEgress: 'none' },
          cost: nonBillableMediaCost('non_billable_local'),
          retention: { mode: 'retain', revision: 0, updatedAt: Date.now() },
          contentStatus: 'available',
          createdAt: Date.now()
        }
        return store.commitMediaAsset({ asset, output })
      },
      isSuccess: Boolean,
      resultSummary: (asset) => JSON.stringify({ assetId: asset.id, digest: asset.digest })
    })
    if (!outcome.value) throw new Error(outcome.status === 'failed' ? outcome.error : 'Media asset import is waiting for reconciliation')
    await new TaskKernel(context.rootDir).deliver(context, {
      status: 'passed', evidenceRefs: [ids.evidenceId!], verifiedBy: 'media-asset-import'
    })
    return outcome.value
  }

  bindMediaAsset(input: MediaAssetBindingInput): Promise<MediaAssetBinding> {
    return getMediaStore(this.rootDir).bindMediaAsset(input)
  }

  setMediaAdoption(input: MediaAdoptionInput): Promise<VideoProduction> {
    return getMediaStore(this.rootDir).setMediaAdoption(input)
  }

  async composeMediaProduction(input: MediaCompositionInput): Promise<MediaCompositionResult> {
    const store = getMediaStore(this.rootDir)
    const production = (await store.getMediaStudio(input.projectId)).productions
      .find((item) => item.id === input.productionId)
    if (!production) throw new Error('Media composition Project/Production scope is invalid')
    await store.assertProjectStorageAvailable(input.projectId)
    const identity = bindingDigest(`${production.id}\0${production.revision}\0${JSON.stringify({
      shotIds: input.shotIds ?? [],
      width: input.width,
      height: input.height,
      fps: input.fps,
      subtitleMode: input.subtitleMode
    })}`)
    const assetTitle = `${production.title} local draft`
    const assetVersion = nextAssetVersion(production.assets, 'video', assetTitle)
    const previousComposition = production.assets
      .filter((asset) => asset.kind === 'video' && asset.authorization?.source === 'local_composition' && asset.artifactId)
      .sort((left, right) => right.version - left.version || right.createdAt - left.createdAt)[0]
    const context = await this.prepareJobContext(`compose:${identity}`, production.title, production.projectId, production.businessLineId)
    const ids = localOutputIdentities('media-composition', identity)
    const target = mediaTarget({
      context,
      operationId: `media-compose-${identity}`,
      operation: 'compose',
      mediaJobId: `media-composition:${identity}`,
      externalJobId: `local-ffmpeg:${identity}`,
      idempotencyKey: `media-compose:${identity}`,
      expectedStatus: 'succeeded',
      ...ids
    })
    const outcome = await executeInteractiveOperationEffect<MediaCompositionResult>({
      rootDir: this.rootDir,
      operationId: target.runId.slice('operation:'.length),
      kind: 'media_generation',
      title: 'Compose local video draft',
      sourceSessionId: `media:${target.mediaJobId}`,
      projectId: context.projectId,
      workspaceId: context.workspaceId,
      goalId: context.goalId,
      workItemId: context.workItemId,
      cwd: context.cwd,
      toolName: 'media_job_operation',
      toolInput: target,
      execute: async (effect) => {
        const composed = await composeProductionDraft(input, production, this.rootDir)
        await store.assertProjectStorageAvailable(input.projectId, composed.sizeBytes)
        const output = await persistLocalMediaArtifact({
          target,
          effect,
          rootDir: this.rootDir,
          sourcePath: composed.managedPath,
          digest: composed.digest,
          sizeBytes: composed.sizeBytes,
          mediaType: composed.mediaType,
          title: assetTitle,
          producer: 'media-ffmpeg-composition',
          metadata: {
            productionId: production.id,
            structureRevisionId: production.adoptedStructureRevisionId,
            ffmpegVersion: composed.ffmpeg.version,
            ffmpegBinaryDigest: composed.ffmpeg.binaryDigest,
            ffmpegLicense: composed.ffmpeg.license,
            commandDigest: composed.ffmpeg.commandDigest,
            width: composed.width,
            height: composed.height,
            durationMs: composed.durationMs
          },
          durationMs: composed.durationMs,
          width: composed.width,
          height: composed.height
        })
        const asset: MediaAsset = {
          schemaVersion: MEDIA_SCHEMA_VERSION,
          id: `asset:${identity}`,
          productionId: production.id,
          kind: 'video',
          title: assetTitle,
          version: assetVersion,
          digest: output.digest,
          mediaType: output.mediaType,
          sizeBytes: output.sizeBytes,
          artifactId: output.artifactId,
          sourceFileName: composed.sourceFileName,
          adopted: false,
          authorization: { source: 'local_composition', status: 'local', dataEgress: 'none' },
          cost: nonBillableMediaCost('non_billable_local'),
          retention: { mode: 'retain', revision: 0, updatedAt: Date.now() },
          contentStatus: 'available',
          createdAt: Date.now()
        }
        const manifestArtifactId = await persistCompositionManifest({
          target,
          effect,
          rootDir: this.rootDir,
          identity,
          version: assetVersion,
          title: `${production.title} composition manifest`,
          manifest: composed.manifest
        })
        await persistCompositionGraph({
          rootDir: this.rootDir,
          projectId: production.projectId,
          finalArtifactId: output.artifactId!,
          manifestArtifactId,
          inputArtifactIds: composed.inputArtifactIds,
          supersededArtifactId: previousComposition?.artifactId,
          identity
        })
        const committed = await store.commitMediaAsset({ asset, output })
        return {
          asset: committed,
          output,
          ffmpeg: composed.ffmpeg,
          manifestArtifactId,
          inputArtifactIds: composed.inputArtifactIds,
          segmentCount: composed.segmentCount,
          subtitleCueCount: composed.subtitleCueCount
          , cost: nonBillableMediaCost('non_billable_local')
        }
      },
      isSuccess: Boolean,
      resultSummary: (result) => JSON.stringify({ assetId: result.asset.id, digest: result.output.digest })
    })
    if (!outcome.value) throw new Error(outcome.status === 'failed' ? outcome.error : 'Media composition is waiting for reconciliation')
    await new TaskKernel(context.rootDir).deliver(context, {
      status: 'passed', evidenceRefs: [ids.evidenceId!], verifiedBy: 'media-ffmpeg-composition'
    })
    return outcome.value
  }

  async submitMediaJob(input: MediaJobInput, agentContext?: MediaAgentExecutionContext): Promise<MediaJobRecord> {
    return withMediaJobOperationQueue(this.rootDir, mediaJobIdForKey(input.idempotencyKey), () => this.submitQueuedMediaJob(input, agentContext))
  }

  private async submitQueuedMediaJob(input: MediaJobInput, agentContext?: MediaAgentExecutionContext): Promise<MediaJobRecord> {
    const store = getMediaStore(this.rootDir)
    const existing = await store.findMediaJobByIdempotencyKey(input.idempotencyKey)
    if (existing) return replayMediaJobBusinessLine(existing, input)
    input = await bindMediaJobBusinessLine(store, input, this.rootDir)
    await store.assertProjectStorageAvailable(input.projectId)
    const production = (await store.getMediaStudio(input.projectId)).productions.find((item) => item.id === input.productionId)!
    const scope = mediaRequestBudgetScope(production, agentContext)
    const routed = await prepareMediaRoute(store, input, { rootDir: this.rootDir, scope })
    if (agentContext) routed.executionBinding.agentOrigin = mediaAgentOrigin(agentContext)
    input = routed.input
    const validated = await store.validateMediaJobInput(input, routed.executionBinding.profile)
    const context = await this.prepareJobContext(validated.jobId, validated.production.title, validated.production.projectId, input.businessLineId)
    const operationId = operationIdFor(validated.jobId, 'submit', 0)
    const target = mediaTarget({
      context,
      operationId,
      operation: 'submit',
      mediaJobId: validated.jobId,
      externalJobId: validated.externalJobId,
      idempotencyKey: input.idempotencyKey,
      expectedStatus: 'submitting'
    })
    return withMediaRequestBudget({ rootDir: this.rootDir, jobId: validated.jobId, scope, binding: routed.executionBinding,
      readJob: () => store.getMediaJob(validated.jobId), execute: () => this.executeOperation(context, target, async (effect) => {
      const operationBinding = binding(context, target.runId, effect.id)
      const prepared = await store.prepareMediaJobSubmission(input, operationBinding, routed.executionBinding)
      if (prepared.providerMode !== 'remote' || !prepared.mediaProviderId) {
        return store.commitMediaJobOperation(prepared.id, { operation: 'submit', status: 'submitting', binding: operationBinding })
      }
      const profile = await mediaProfileForJob(store, prepared)
      const observation = await executeRemoteMediaOperation(profile, prepared, 'submit', this.rootDir)
      return store.commitMediaJobOperation(prepared.id, {
        operation: 'submit',
        status: observation.status,
        binding: operationBinding,
        reason: observation.reason,
        remoteOutputRef: observation.outputUrl,
        remoteOutputMediaType: observation.mediaType,
        providerExternalJobId: observedMediaProviderJobId(prepared, observation),
        preparedOutputPath: observation.outputFilePath,
        preparedOutputDigest: observation.outputDigest,
        preparedOutputSizeBytes: observation.outputSizeBytes,
        downloadReceivedBytes: observation.downloadReceivedBytes,
        downloadTotalBytes: observation.downloadTotalBytes,
        actualUsd: observation.actualUsd,
        billingReceiptDigest: observation.billingReceiptDigest
      })
    }) })
  }

  async advanceMediaJob(jobId: string): Promise<MediaJobRecord> {
    return withMediaJobOperationQueue(this.rootDir, jobId, () => this.advanceQueuedMediaJob(jobId))
  }

  private async advanceQueuedMediaJob(jobId: string): Promise<MediaJobRecord> {
    const store = getMediaStore(this.rootDir)
    const job = await store.getMediaJob(jobId)
    if (!job) throw new Error('MediaJob was not found')
    if (isTerminal(job.status)) return job
    if (job.status === 'requested') throw new Error('MediaJob was not submitted through the canonical runtime')
    if (job.status === 'waiting_reconciliation') {
      throw new Error('MediaJob is waiting for explicit external-result reconciliation')
    }
    const production = (await store.getMediaStudio(job.projectId)).productions.find((item) => item.id === job.productionId)
    if (!production) throw new Error('MediaJob Production was not found')
    const context = await this.prepareJobContext(job.id, production.title, job.projectId, job.businessLineId ?? production.businessLineId)
    const transition = nextTransition(job)
    const operationId = operationIdFor(job.id, transition.operation, job.statusHistory.length)
    const identities = transition.operation === 'download' ? outputIdentities(job.id) : undefined
    const target = mediaTarget({
      context,
      operationId,
      operation: transition.operation,
      mediaJobId: job.id,
      externalJobId: job.externalJobId,
      idempotencyKey: job.idempotencyKey,
      expectedStatus: transition.status,
      ...identities
    })
    const result = await this.executeOperation(context, target, async (effect) => {
      const operationBinding = binding(context, target.runId, effect.id)
      const observation = job.providerMode === 'remote' && job.mediaProviderId
        ? await executeRemoteMediaOperation(
          await mediaProfileForJob(store, job),
          job,
          transition.operation,
          this.rootDir
        )
        : undefined
      if (observation && observation.status !== transition.status) {
        return store.commitMediaJobOperation(job.id, { operation: transition.operation, status: observation.status, binding: operationBinding, reason: observation.reason, remoteOutputRef: observation.outputUrl, remoteOutputMediaType: observation.mediaType, providerExternalJobId: observedMediaProviderJobId(job, observation), preparedOutputPath: observation.outputFilePath, preparedOutputDigest: observation.outputDigest, preparedOutputSizeBytes: observation.outputSizeBytes, downloadReceivedBytes: observation.downloadReceivedBytes, downloadTotalBytes: observation.downloadTotalBytes, actualUsd: observation.actualUsd, billingReceiptDigest: observation.billingReceiptDigest })
      }
      if (transition.operation === 'download' && transition.status === 'succeeded') {
        const output = observation?.outputFilePath && observation.outputDigest && observation.outputSizeBytes
          ? await persistRemoteMediaOutput(job, target, effect, this.rootDir, observation.outputFilePath, observation.outputDigest, observation.outputSizeBytes, observation.mediaType)
          : await persistMediaOutput(job, target, effect, this.rootDir)
        return store.commitMediaJobOperation(job.id, { ...transition, binding: operationBinding, output })
      }
      return store.commitMediaJobOperation(job.id, { ...transition, binding: operationBinding, remoteOutputRef: observation?.outputUrl, remoteOutputMediaType: observation?.mediaType, providerExternalJobId: observedMediaProviderJobId(job, observation), preparedOutputPath: observation?.outputFilePath, preparedOutputDigest: observation?.outputDigest, preparedOutputSizeBytes: observation?.outputSizeBytes, downloadReceivedBytes: observation?.downloadReceivedBytes, downloadTotalBytes: observation?.downloadTotalBytes, actualUsd: observation?.actualUsd, billingReceiptDigest: observation?.billingReceiptDigest })
    })
    if (transition.operation === 'poll') await reconcileMediaOperationEffects(result, this.rootDir)
    if (isTerminal(result.status)) await settleTerminal(context, result)
    return result
  }

  async cancelMediaJob(jobId: string): Promise<MediaJobRecord> {
    return withMediaJobOperationQueue(this.rootDir, jobId, () => this.cancelQueuedMediaJob(jobId))
  }

  private async cancelQueuedMediaJob(jobId: string): Promise<MediaJobRecord> {
    const store = getMediaStore(this.rootDir)
    const job = await store.getMediaJob(jobId)
    if (!job) throw new Error('MediaJob was not found')
    if (isTerminal(job.status)) return job
    const production = (await store.getMediaStudio(job.projectId)).productions.find((item) => item.id === job.productionId)
    if (!production) throw new Error('MediaJob Production was not found')
    const context = await this.prepareJobContext(job.id, production.title, job.projectId, job.businessLineId ?? production.businessLineId)
    const operationId = operationIdFor(job.id, 'cancel', job.statusHistory.length)
    const target = mediaTarget({
      context,
      operationId,
      operation: 'cancel',
      mediaJobId: job.id,
      externalJobId: job.externalJobId,
      idempotencyKey: job.idempotencyKey,
      expectedStatus: 'cancelled'
    })
    const result = await this.executeOperation(context, target, async (effect) => {
      let status: MediaJobRecord['status'] = 'cancelled'
      let reason = 'Cancelled by user'
      let actualUsd: number | undefined, billingReceiptDigest: string | undefined
      if (job.providerMode === 'remote' && job.mediaProviderId) {
        const profile = await mediaProfileForJob(store, job)
        const observation = await executeRemoteMediaOperation(profile, job, 'cancel', this.rootDir)
        status = observation.status
        reason = observation.reason ?? reason
        actualUsd = observation.actualUsd; billingReceiptDigest = observation.billingReceiptDigest
      }
      return store.commitMediaJobOperation(job.id, { operation: 'cancel', status, binding: binding(context, target.runId, effect.id), reason, actualUsd, billingReceiptDigest })
    })
    await settleTerminal(context, result)
    return result
  }

  async reconcileMediaJob(jobId: string): Promise<MediaJobRecord> {
    return withMediaJobOperationQueue(this.rootDir, jobId, () => this.reconcileQueuedMediaJob(jobId))
  }

  private async reconcileQueuedMediaJob(jobId: string): Promise<MediaJobRecord> {
    const store = getMediaStore(this.rootDir)
    const job = await store.getMediaJob(jobId)
    if (!job) throw new Error('MediaJob was not found')
    if (job.status !== 'waiting_reconciliation') throw new Error('MediaJob does not require external reconciliation')
    if (job.providerMode !== 'remote' || !job.mediaProviderId) {
      throw new Error('Only remote MediaJobs can query an external result')
    }
    if (missingMediaReconciliationIdentity(job, 'poll')) return job
    const production = (await store.getMediaStudio(job.projectId)).productions.find((item) => item.id === job.productionId)
    if (!production) throw new Error('MediaJob Production was not found')
    const profile = await mediaProfileForJob(store, job)
    const context = await this.prepareJobContext(job.id, production.title, job.projectId, job.businessLineId ?? production.businessLineId)
    const operationId = operationIdFor(job.id, 'reconcile', job.statusHistory.length)
    const target = mediaTarget({
      context,
      operationId,
      operation: 'poll',
      mediaJobId: job.id,
      externalJobId: job.externalJobId,
      idempotencyKey: job.idempotencyKey,
      expectedStatus: 'running'
    })
    const result = await this.executeOperation(context, target, async (effect) => {
      const observation = await executeRemoteMediaOperation(profile, job, 'poll', this.rootDir)
      return store.commitMediaJobOperation(job.id, {
        operation: 'poll',
        status: observation.status,
        binding: binding(context, target.runId, effect.id),
        reason: observation.reason,
        remoteOutputRef: observation.outputUrl,
        remoteOutputMediaType: observation.mediaType,
        providerExternalJobId: observedMediaProviderJobId(job, observation),
        preparedOutputPath: observation.outputFilePath,
        preparedOutputDigest: observation.outputDigest,
        preparedOutputSizeBytes: observation.outputSizeBytes,
        downloadReceivedBytes: observation.downloadReceivedBytes,
        downloadTotalBytes: observation.downloadTotalBytes,
        actualUsd: observation.actualUsd,
        billingReceiptDigest: observation.billingReceiptDigest
      })
    })
    await reconcileMediaOperationEffects(result, this.rootDir)
    if (isTerminal(result.status)) await settleTerminal(context, result)
    return result
  }

  private prepareJobContext(
    jobId: string,
    productionTitle: string,
    projectId: string, businessLineId?: string
  ): Promise<CanonicalSystemOperationContext> {
    return prepareCanonicalSystemOperation({
      rootDir: this.rootDir,
      requestId: `media-${bindingDigest(jobId)}`,
      objective: `Generate and verify media for ${productionTitle}`,
      workspaceId: projectId, businessLineId
    })
  }

  private async executeOperation(
    context: CanonicalSystemOperationContext,
    target: MediaJobOperationTarget,
    execute: (effect: EffectRecord) => Promise<MediaJobRecord>
  ): Promise<MediaJobRecord> {
    const outcome = await executeInteractiveOperationEffect({
      rootDir: this.rootDir,
      operationId: target.runId.slice('operation:'.length),
      kind: 'media_generation',
      title: mediaOperationTitle(target.operation),
      sourceSessionId: `media:${target.mediaJobId}`,
      projectId: context.projectId,
      workspaceId: context.workspaceId,
      goalId: context.goalId,
      workItemId: context.workItemId,
      cwd: context.cwd,
      toolName: 'media_job_operation',
      toolInput: target,
      execute,
      isSuccess: (job) => job.status !== 'waiting_reconciliation',
      resultSummary: (job) => JSON.stringify({
        mediaJobId: job.id,
        capability: job.capability,
        operation: job.operation,
        providerMode: job.providerMode,
        status: job.status,
        outputDigest: job.output?.digest
      })
    })
    if (outcome.value) { reconcileMediaRequestBudget(outcome.value, this.rootDir); return outcome.value }
    if (outcome.status === 'waiting_reconciliation') {
      const persisted = await getMediaStore(this.rootDir).getMediaJob(target.mediaJobId)
      if (persisted) return persisted
      throw new Error(`MediaJob operation is waiting for reconciliation:${outcome.snapshotId}`)
    }
    if (outcome.status === 'failed') throw new Error(outcome.error)
    throw new Error('MediaJob operation completed without a durable result')
  }
}

function requiredRetentionExpiry(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error('Media retention expiry is invalid')
  return Number(value)
}

async function removeManagedMediaSource(rootDir: string, projectId: string, sourcePath: string): Promise<number> {
  const projectRoot = resolve(rootDir, 'media-files', createHash('sha256').update(projectId).digest('hex'))
  if (!isAbsolute(sourcePath)) throw new Error('MediaAsset source path is invalid')
  const scoped = relative(projectRoot, resolve(sourcePath))
  if (!scoped || scoped === '..' || scoped.startsWith(`..${sep}`) || isAbsolute(scoped)) {
    throw new Error('MediaAsset source is outside EastGenesis managed storage')
  }
  try {
    const state = await lstat(sourcePath)
    if (!state.isFile() || state.isSymbolicLink()) throw new Error('MediaAsset managed source is invalid')
    await rm(sourcePath, { force: true })
    return state.size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

async function persistMediaOutput(
  job: MediaJobRecord,
  target: MediaJobOperationTarget,
  effect: EffectRecord,
  rootDir: string
): Promise<MediaJobOutput> {
  if (!target.artifactId || !target.evidenceId || !target.acceptanceId) {
    throw new Error('Media output identities are missing')
  }
  const mock = await mockOutput(job, rootDir)
  const bytes = mock.bytes
  const expectedDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  const mediaType = mock.mediaType
  const persisted = await registerCanonicalProducedArtifact({
    lifecycle: {
      id: target.artifactId,
      projectId: target.projectId,
      goalId: target.goalId,
      workItemId: target.workItemId,
      runId: target.runId,
      lineageId: `lineage:media-job:${job.id}`,
      kind: 'custom',
      title: `Mock ${job.capability} output`,
      version: job.attempt,
      provenance: 'explicit',
      mediaType,
      retention: { mode: 'retain' },
      content: { storageKind: 'blob', bytes, expectedDigest },
      metadata: {
        producer: 'media-runtime',
        mediaJobId: job.id,
        productionId: job.productionId,
        shotId: job.shotId,
        dialogueCueId: job.dialogueCueId,
        capability: job.capability,
        providerId: job.providerId,
        providerMode: job.providerMode,
        effectId: effect.id
      }
    },
    evidence: {
      id: target.evidenceId,
      kind: 'delivery_check',
      title: 'Media output integrity',
      summary: 'Mock Provider output bytes were downloaded, digested and committed to canonical Artifact storage.',
      verifier: 'media-runtime',
      metadata: {
        mediaJobId: job.id,
        effectId: effect.id,
        outputDigest: expectedDigest,
        outputBytes: bytes.byteLength
      }
    },
    acceptance: {
      id: target.acceptanceId,
      criterionId: `${target.acceptanceId}:criterion:integrity`,
      criterion: 'Media output bytes match the recorded digest and are available from canonical Artifact storage.',
      status: 'passed',
      verifier: 'media-runtime', authorizesWorkflowStage: true
    },
    attachToStage: true
  }, rootDir)
  return {
    digest: persisted.lifecycle.digest,
    sizeBytes: persisted.lifecycle.sizeBytes,
    mediaType,
    blobRef: persisted.lifecycle.blobRef ?? `sha256/${persisted.lifecycle.digest.slice('sha256:'.length)}`,
    artifactId: persisted.artifact.id,
    evidenceId: persisted.evidenceId,
    acceptanceId: persisted.acceptanceId,
    runId: target.runId,
    effectId: effect.id,
    ...(mock.durationMs === undefined ? {} : { durationMs: mock.durationMs }),
    ...(mock.width === undefined ? {} : { width: mock.width }),
    ...(mock.height === undefined ? {} : { height: mock.height })
  }
}

async function persistRemoteMediaOutput(
  job: MediaJobRecord,
  target: MediaJobOperationTarget,
  effect: EffectRecord,
  rootDir: string,
  sourcePath: string,
  expectedDigest: string,
  sizeBytes: number,
  mediaType = 'application/octet-stream'
): Promise<MediaJobOutput> {
  if (!target.artifactId || !target.evidenceId || !target.acceptanceId || sizeBytes === 0) {
    throw new Error('Remote media output is missing canonical identities or bytes')
  }
  const persisted = await registerCanonicalProducedArtifact({
    lifecycle: {
      id: target.artifactId,
      projectId: target.projectId,
      goalId: target.goalId,
      workItemId: target.workItemId,
      runId: target.runId,
      lineageId: `lineage:media-job:${job.id}`,
      kind: 'custom',
      title: `${job.capability} output`,
      version: job.attempt,
      provenance: 'explicit',
      mediaType,
      retention: { mode: 'retain' },
      content: { storageKind: 'source_ref', sourceRef: sourcePath, expectedDigest },
      metadata: {
        producer: 'media-provider-runtime',
        mediaJobId: job.id,
        productionId: job.productionId,
        shotId: job.shotId,
        capability: job.capability,
        providerId: job.providerId,
        mediaProviderId: job.mediaProviderId,
        providerExternalJobId: job.providerExternalJobId,
        effectId: effect.id
      }
    },
    evidence: {
      id: target.evidenceId,
      kind: 'delivery_check',
      title: 'Remote media output integrity',
      summary: 'Provider output bytes were downloaded through a scoped credential lease, digested and committed to canonical Artifact storage.',
      verifier: 'media-provider-runtime',
      metadata: { mediaJobId: job.id, effectId: effect.id, outputDigest: expectedDigest, outputBytes: sizeBytes }
    },
    acceptance: {
      id: target.acceptanceId,
      criterionId: `${target.acceptanceId}:criterion:integrity`,
      criterion: 'Remote media output bytes match the recorded digest and are available from canonical Artifact storage.',
      status: 'passed',
      verifier: 'media-provider-runtime', authorizesWorkflowStage: true
    },
    attachToStage: true
  }, rootDir)
  return {
    digest: persisted.lifecycle.digest,
    sizeBytes: persisted.lifecycle.sizeBytes,
    mediaType,
    blobRef: persisted.lifecycle.sourceRef ?? sourcePath,
    artifactId: persisted.artifact.id,
    evidenceId: persisted.evidenceId,
    acceptanceId: persisted.acceptanceId,
    runId: target.runId,
    effectId: effect.id
  }
}

async function persistLocalMediaArtifact(input: {
  target: MediaJobOperationTarget
  effect: EffectRecord
  rootDir: string
  sourcePath: string
  digest: string
  sizeBytes: number
  mediaType: string
  title: string
  producer: string
  metadata: Record<string, unknown>
  durationMs?: number
  width?: number
  height?: number
}): Promise<MediaJobOutput> {
  const { target, effect } = input
  if (!target.artifactId || !target.evidenceId || !target.acceptanceId) {
    throw new Error('Local media output identities are missing')
  }
  const persisted = await registerCanonicalProducedArtifact({
    lifecycle: {
      id: target.artifactId,
      projectId: target.projectId,
      goalId: target.goalId,
      workItemId: target.workItemId,
      runId: target.runId,
      lineageId: `lineage:${target.mediaJobId}`,
      kind: 'custom',
      title: input.title,
      version: 1,
      provenance: 'explicit',
      mediaType: input.mediaType,
      retention: { mode: 'retain' },
      content: { storageKind: 'source_ref', sourceRef: input.sourcePath, expectedDigest: input.digest },
      metadata: {
        producer: input.producer,
        mediaOperation: target.operation,
        effectId: effect.id,
        ...input.metadata
      }
    },
    evidence: {
      id: target.evidenceId,
      kind: 'delivery_check',
      title: 'Local media integrity',
      summary: 'Media bytes were streamed into controlled local storage and committed with a stable SHA-256 digest.',
      verifier: input.producer,
      metadata: { effectId: effect.id, outputDigest: input.digest, outputBytes: input.sizeBytes }
    },
    acceptance: {
      id: target.acceptanceId,
      criterionId: `${target.acceptanceId}:criterion:integrity`,
      criterion: 'Local media bytes match the recorded digest and remain available from project-owned storage.',
      status: 'passed',
      verifier: input.producer, authorizesWorkflowStage: true
    },
    attachToStage: true
  }, input.rootDir)
  return {
    digest: persisted.lifecycle.digest,
    sizeBytes: persisted.lifecycle.sizeBytes,
    mediaType: input.mediaType,
    blobRef: persisted.lifecycle.sourceRef ?? input.sourcePath,
    artifactId: persisted.artifact.id,
    evidenceId: persisted.evidenceId,
    acceptanceId: persisted.acceptanceId,
    runId: target.runId,
    effectId: effect.id,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.width === undefined ? {} : { width: input.width }),
    ...(input.height === undefined ? {} : { height: input.height })
  }
}

async function persistCompositionManifest(input: {
  target: MediaJobOperationTarget
  effect: EffectRecord
  rootDir: string
  identity: string
  version: number
  title: string
  manifest: MediaCompositionManifest
}): Promise<string> {
  const bytes = Buffer.from(`${JSON.stringify(input.manifest, null, 2)}\n`, 'utf8')
  const expectedDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  const artifactId = `artifact:media-composition-manifest:${input.identity}`
  const persisted = await registerCanonicalProducedArtifact({
    lifecycle: {
      id: artifactId,
      projectId: input.target.projectId,
      goalId: input.target.goalId,
      workItemId: input.target.workItemId,
      runId: input.target.runId,
      lineageId: `lineage:media-composition-manifest:${input.identity}`,
      kind: 'custom',
      title: input.title,
      version: 1,
      provenance: 'explicit',
      mediaType: 'application/vnd.caogen.media-composition+json',
      retention: { mode: 'retain' },
      content: { storageKind: 'blob', bytes, expectedDigest },
      metadata: {
        producer: 'media-ffmpeg-composition',
        mediaOperation: 'compose_manifest',
        effectId: input.effect.id,
        productionId: input.manifest.productionId,
        productionRevision: input.manifest.productionRevision,
        commandDigest: input.manifest.ffmpeg.commandDigest
      }
    },
    evidence: {
      id: `evidence:media-composition-manifest:${input.identity}`,
      kind: 'delivery_check',
      title: 'Media composition manifest integrity',
      summary: 'The composition manifest records the exact timeline, source Artifacts and local FFmpeg pipeline.',
      verifier: 'media-ffmpeg-composition',
      metadata: { outputDigest: expectedDigest, outputBytes: bytes.byteLength }
    },
    acceptance: {
      id: `acceptance:media-composition-manifest:${input.identity}`,
      criterionId: `acceptance:media-composition-manifest:${input.identity}:criterion:integrity`,
      criterion: 'The composition manifest is immutable and bound to the generated MP4 pipeline inputs.',
      status: 'passed',
      verifier: 'media-ffmpeg-composition'
    }
  }, input.rootDir)
  return persisted.artifact.id
}

async function persistCompositionGraph(input: {
  rootDir: string
  projectId: string
  finalArtifactId: string
  manifestArtifactId: string
  inputArtifactIds: string[]
  supersededArtifactId?: string
  identity: string
}): Promise<void> {
  for (const artifactId of input.inputArtifactIds) {
    const edgeIdentity = bindingDigest(`${input.identity}\0${artifactId}`)
    await createPersistedWorkflowArtifactEdge({
      id: `artifact-edge:media-input-manifest:${edgeIdentity}`,
      fromArtifactId: artifactId,
      toArtifactId: input.manifestArtifactId,
      relation: 'input_to',
      projectId: input.projectId,
      metadata: { producer: 'media-ffmpeg-composition' }
    }, input.rootDir)
    await createPersistedWorkflowArtifactEdge({
      id: `artifact-edge:media-final-source:${edgeIdentity}`,
      fromArtifactId: input.finalArtifactId,
      toArtifactId: artifactId,
      relation: 'derived_from',
      projectId: input.projectId,
      metadata: { producer: 'media-ffmpeg-composition' }
    }, input.rootDir)
  }
  await createPersistedWorkflowArtifactEdge({
    id: `artifact-edge:media-final-manifest:${input.identity}`,
    fromArtifactId: input.finalArtifactId,
    toArtifactId: input.manifestArtifactId,
    relation: 'output_of',
    projectId: input.projectId,
    metadata: { producer: 'media-ffmpeg-composition' }
  }, input.rootDir)
  if (input.supersededArtifactId) {
    await createPersistedWorkflowArtifactEdge({
      id: `artifact-edge:media-final-supersedes:${input.identity}`,
      fromArtifactId: input.finalArtifactId,
      toArtifactId: input.supersededArtifactId,
      relation: 'supersedes',
      projectId: input.projectId,
      metadata: { producer: 'media-ffmpeg-composition' }
    }, input.rootDir)
  }
}

async function mockOutput(job: MediaJobRecord, rootDir: string): Promise<{
  bytes: Buffer
  mediaType: string
  durationMs?: number
  width?: number
  height?: number
}> {
  if (job.capability === 'tts') {
    return { bytes: mockWavBytes(Math.max(1, Math.ceil((job.requestPrompt?.length ?? 1) / 12))), mediaType: 'audio/wav' }
  }
  const temporaryRoot = await mkdtemp(`${rootDir}/.media-mock-`)
  const extension = job.capability === 'image' ? 'png' : 'mp4'
  const outputPath = `${temporaryRoot}/output.${extension}`
  const seed = createHash('sha256').update(job.id).digest('hex').slice(0, 6)
  const color = `0x${seed}`
  try {
    const binary = ffmpegPath()
    if (job.capability === 'image') {
      await execFileAsync(binary, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `color=c=${color}:s=1024x576`,
        '-frames:v', '1', '-c:v', 'png', outputPath
      ], { env: buildMinimalSubprocessEnv(), timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
      return { bytes: await readFile(outputPath), mediaType: 'image/png', width: 1024, height: 576 }
    }
    await execFileAsync(binary, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=${color}:s=1280x720:r=24:d=5`,
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-t', '5', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', outputPath
    ], { env: buildMinimalSubprocessEnv(), timeout: 120_000, maxBuffer: 2 * 1024 * 1024 })
    return { bytes: await readFile(outputPath), mediaType: 'video/mp4', durationMs: 5_000, width: 1280, height: 720 }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function mockOutputBytes(job: MediaJobRecord): Buffer {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    format: 'caogen.media-mock.v1',
    mediaJobId: job.id,
    productionId: job.productionId,
    shotId: job.shotId,
    capability: job.capability,
    operation: job.operation,
    providerId: job.providerId,
    externalJobId: job.externalJobId,
    disclaimer: 'Legacy mock output fallback; not a playable production media file.'
  }, null, 2)}\n`, 'utf8')
}

function mockWavBytes(durationSeconds: number): Buffer {
  const sampleRate = 16_000
  const sampleCount = Math.min(sampleRate * 30, sampleRate * durationSeconds)
  const dataSize = sampleCount * 2
  const bytes = Buffer.alloc(44 + dataSize)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + dataSize, 4); bytes.write('WAVE', 8)
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(dataSize, 40)
  for (let index = 0; index < sampleCount; index += 1) {
    const edge = Math.min(1, index / (sampleRate * 0.04), (sampleCount - index) / (sampleRate * 0.04))
    const sample = Math.sin((2 * Math.PI * 220 * index) / sampleRate) * 0.12 * Math.max(0, edge)
    bytes.writeInt16LE(Math.round(sample * 32767), 44 + index * 2)
  }
  return bytes
}

function mediaOperationTitle(operation: MediaJobOperationTarget['operation']): string {
  return ({
    submit: 'Submit media generation',
    poll: 'Poll media generation',
    download: 'Download media output',
    cancel: 'Cancel media generation',
    asset_import: 'Import media asset',
    compose: 'Compose local video draft',
    continuity_check: 'Check media continuity'
  })[operation]
}

function adoptedProductionShotIds(production: VideoProduction): string[] {
  const structure = production.structureRevisions.find((candidate) => candidate.id === production.adoptedStructureRevisionId)
  return structure?.shotIds.filter((shotId) => production.shots.some((shot) => shot.id === shotId)) ?? production.shots.map((shot) => shot.id)
}

function evaluateContinuity(
  production: VideoProduction,
  shotIds: string[],
  locks: readonly MediaContinuityLock[]
): MediaContinuityFinding[] {
  const findings: MediaContinuityFinding[] = []
  for (const lock of locks) {
    for (const shotId of lock.targetShotIds.filter((id) => shotIds.includes(id))) {
      const shot = production.shots.find((candidate) => candidate.id === shotId)!
      const adopted = (shot.assetBindings ?? []).filter((binding) => binding.role === lock.role && binding.adopted)
      if (adopted.length === 0) {
        findings.push({ code: 'missing_binding', severity: 'error', lockId: lock.id, shotId, message: `${lock.label}: ${shot.title} lacks an adopted ${lock.role} binding.` })
        continue
      }
      if (adopted.length > 1) findings.push({ code: 'multiple_adopted_bindings', severity: 'error', lockId: lock.id, shotId, message: `${lock.label}: ${shot.title} has multiple adopted ${lock.role} bindings.` })
      if (!adopted.some((binding) => binding.assetId === lock.assetId)) findings.push({ code: 'asset_mismatch', severity: 'error', lockId: lock.id, shotId, message: `${lock.label}: ${shot.title} uses a different ${lock.role} Asset.` })
      const matching = adopted.find((binding) => binding.assetId === lock.assetId)
      if (matching && matching.assetVersion !== lock.assetVersion) findings.push({ code: 'version_mismatch', severity: 'error', lockId: lock.id, shotId, message: `${lock.label}: ${shot.title} uses Asset v${matching.assetVersion}; lock requires v${lock.assetVersion}.` })
    }
  }
  return findings
}

function nextAssetVersion(assets: readonly MediaAsset[], kind: MediaAsset['kind'], title: string): number {
  return assets.filter((asset) => asset.kind === kind && asset.title === title).reduce((max, asset) => Math.max(max, asset.version), 0) + 1
}

const runtimes = new Map<string, MediaRuntime>()

export function getMediaRuntime(rootDir: string): MediaRuntime {
  const existing = runtimes.get(rootDir)
  if (existing) return existing
  const runtime = new MediaRuntime(rootDir)
  runtimes.set(rootDir, runtime)
  return runtime
}
