import type { MediaExecutionBinding, MediaJobInput, MediaJobRecord, MediaProviderProfile, MediaStudioSnapshot } from '../../shared/media-types'
import { getProviderConnectionIdentity, listProviders } from '../providers'
import { getHealth } from '../providerHealth'
import { getSettings } from '../settings'
import { getBusinessLines } from '../../shared/business-line-types'
import { stableValueDigest } from '../task/tool-idempotency'
import { mergeMediaCatalog } from './media-provider-catalog'
import { selectMediaRoute } from './media-route-selection'
import type { MediaStore } from './media-store'
import { mediaSubmissionContentDigest, mediaSubmissionDigest } from './media-submission-identity'
import { assertMediaSubmissionReconciled } from './media-reconciliation-identity'
import type { RequestBudgetScope } from '../budget/request-budget-types'
import { remainingRequestBudget } from './media-request-budget'
import { freezeMediaRoute } from './media-frozen-route'

export async function runtimeMediaProviders(store: MediaStore): Promise<MediaProviderProfile[]> {
  return mergeMediaCatalog(await store.listMediaProviders(), listProviders())
}

export async function runtimeMediaStudio(store: MediaStore, projectId?: string): Promise<MediaStudioSnapshot> {
  const snapshot = await store.getMediaStudio(projectId)
  const providers = mergeMediaCatalog(snapshot.providers, listProviders())
  return { ...snapshot, providers, snapshotDigest: stableValueDigest({ previous: snapshot.snapshotDigest, providers }) }
}

export async function prepareMediaRoute(store: MediaStore, input: MediaJobInput, budget?: { rootDir: string; scope: RequestBudgetScope }): Promise<{
  input: MediaJobInput
  executionBinding: MediaExecutionBinding
}> {
  const requestDigest = mediaSubmissionDigest(input)
  const contentDigest = mediaSubmissionContentDigest(input)
  const snapshot = await store.getMediaStudio(input.projectId)
  assertMediaSubmissionReconciled(snapshot.jobs, contentDigest)
  const production = snapshot.productions.find((item) => item.id === input.productionId)
  if (!production) throw new Error('Media Production was not found')
  const cue = production.shots.find((shot) => shot.id === input.shotId)?.dialogueCues.find((item) => item.id === input.dialogueCueId)
  if (cue) input = { ...input, prompt: cue.text }
  const providers = listProviders()
  const settings = getSettings()
  const businessLinePreference = input.businessLineId
    ? getBusinessLines(settings).find((line) => line.id === input.businessLineId)?.routingPreference
    : undefined
  let executionBinding = selectMediaRoute({
    request: input,
    profiles: mergeMediaCatalog(snapshot.providers, providers),
    providers,
    production,
    jobs: snapshot.jobs,
    strategy: settings.schedulerStrategy,
    businessLinePreference,
    requestBudgetRemainingUsd: budget ? remainingRequestBudget(budget.rootDir, budget.scope) : undefined,
    policy: settings.routingExpertPolicy,
    health: Object.fromEntries(providers.map((provider) => [provider.id, getHealth(provider.id)]))
  })
  // A remote media submission is an asynchronous Effect: preserve the exact
  // main-owned Provider connection generation alongside the resolved endpoint
  // and model.  The transport can then fail closed before every poll,
  // download, or cancel if the connection was edited after submission.
  if (executionBinding.profile.endpointClass !== 'mock' && executionBinding.profile.providerId && executionBinding.target) {
    const connectionIdentity = getProviderConnectionIdentity(executionBinding.profile.providerId)
    executionBinding = {
      ...executionBinding,
      target: { ...executionBinding.target, connectionIdentity }
    }
  }
  executionBinding = { ...executionBinding, requestDigest, contentDigest }
  const frozenRoute = freezeMediaRoute(input, executionBinding)
  return {
    input: { ...input, mediaProviderId: executionBinding.profile.id,
      providerId: executionBinding.profile.providerId, model: executionBinding.target?.model ?? executionBinding.profile.model },
    executionBinding: { ...executionBinding, requestDigest, contentDigest, frozenRoute }
  }
}

export async function mediaProfileForJob(store: MediaStore, job: MediaJobRecord): Promise<MediaProviderProfile> {
  if (job.executionBinding) return job.executionBinding.profile
  const legacy = (await store.listMediaProviders()).find((profile) => profile.id === job.mediaProviderId)
  if (!legacy) throw new Error('Media Provider was deleted')
  return legacy
}
