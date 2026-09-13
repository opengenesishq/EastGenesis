import { parseVideoStoryboardDraft } from '../../shared/video-storyboard-types'
import type { MediaProductionRevisionInput } from '../../shared/media-types'

export function normalizeStoryboardInput(input: Record<string, unknown>): Pick<MediaProductionRevisionInput, 'storyboardDraft' | 'expectedRevision'> {
  const result: Pick<MediaProductionRevisionInput, 'storyboardDraft' | 'expectedRevision'> = {}
  if (input.storyboardDraft !== undefined) result.storyboardDraft = parseVideoStoryboardDraft(input.storyboardDraft)
  if (input.expectedRevision !== undefined) {
    if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1) throw new Error('expectedRevision is invalid')
    result.expectedRevision = Number(input.expectedRevision)
  }
  return result
}
