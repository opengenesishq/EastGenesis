import { createHash } from 'node:crypto'
import type { MediaProductionInput, VideoProduction } from '../../shared/media-types'
import { parseVideoStoryboardDraft } from '../../shared/video-storyboard-types'
import { assertSameBusinessLine } from '../business-line-ownership'
import { canonicalJson } from '../project-workspace/codec'

export function productionScript(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('production script is required')
  if (value.length > 200_000) throw new Error('production script exceeds 200000 characters; shorten it before saving')
  return value.trim()
}

export function mediaProductionCreationDigest(input: MediaProductionInput): string {
  const request = { projectId: input.projectId.trim(), title: input.title.trim().slice(0, 240), script: productionScript(input.script),
    autoStructure: input.autoStructure !== false, storyboardDraft: input.storyboardDraft ? parseVideoStoryboardDraft(input.storyboardDraft) : undefined }
  return `sha256:${createHash('sha256').update(canonicalJson(request)).digest('hex')}`
}

export function assertProductionCreationReplay(existing: VideoProduction, input: MediaProductionInput, expected: Pick<VideoProduction, 'projectId' | 'title' | 'script'>): void {
  assertSameBusinessLine(input.businessLineId, existing.businessLineId, 'video')
  if (existing.projectId !== expected.projectId || existing.title !== expected.title || existing.script !== expected.script) throw new Error('VideoProduction identity conflict')
  if (existing.creationRequestDigest && existing.creationRequestDigest !== mediaProductionCreationDigest(input)) throw new Error('VideoProduction storyboard creation identity conflict')
  if (!existing.creationRequestDigest && input.storyboardDraft) throw new Error('旧制作未保留分镜创建指纹，请使用制作修订入口采用新草稿')
}
