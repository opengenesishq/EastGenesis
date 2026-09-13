import type { MediaJobInput, MediaJobRecord, MediaProductionInput, VideoProduction } from '../../shared/media-types'
import { assertSameBusinessLine, newBusinessLineId } from '../business-line-ownership'
import { assertActiveBusinessLine } from '../business-line-registry-reader'
import type { MediaStore } from './media-store'
import { assertMediaSubmissionReplay } from './media-submission-identity'

export async function createBusinessLineProduction(store: MediaStore, input: MediaProductionInput, rootDir: string): Promise<VideoProduction> {
  const existing = input.id ? (await store.getMediaStudio(input.projectId)).productions.find((item) => item.id === input.id) : undefined
  if (!existing) assertActiveBusinessLine(newBusinessLineId(input.businessLineId, undefined, 'video'), rootDir)
  return store.createVideoProduction(input)
}

export async function bindMediaJobBusinessLine(store: MediaStore, input: MediaJobInput, rootDir: string): Promise<MediaJobInput> {
  const production = (await store.getMediaStudio(input.projectId)).productions.find((item) => item.id === input.productionId)
  if (!production) throw new Error('Media job Project/Production scope is invalid')
  const businessLineId = newBusinessLineId(input.businessLineId, production.businessLineId ?? 'video')
  assertActiveBusinessLine(businessLineId, rootDir)
  return { ...input, businessLineId }
}

export function replayMediaJobBusinessLine(existing: MediaJobRecord, input: MediaJobInput): MediaJobRecord {
  assertSameBusinessLine(input.businessLineId, existing.businessLineId, 'video')
  return assertMediaSubmissionReplay(existing, { ...input, ...(existing.businessLineId ? { businessLineId: existing.businessLineId } : {}) })
}
