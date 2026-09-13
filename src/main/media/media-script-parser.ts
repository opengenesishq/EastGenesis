import { parseVideoStoryboardDraft, type VideoStoryboardSceneDraft } from '../../shared/video-storyboard-types'

const SCENE_HEADER = /^(?:#{1,3}\s*)?(?:scene\b|场景|第\s*[\d一二三四五六七八九十百]+\s*场)/iu
const SHOT_HEADER = /^(?:[-*]\s*)?(?:shot\b|镜头|分镜|\d+[.)、])/iu

/** A lossless editable starting structure, not a claim of AI direction. */
export function parseVideoScript(script: string): VideoStoryboardSceneDraft[] {
  const normalized = script.replaceAll('\r\n', '\n').trim()
  if (!normalized) throw new Error('制作剧本不能为空')
  const explicit = splitAtHeaders(normalized, SCENE_HEADER)
  const hasSceneHeaders = explicit.some((part) => SCENE_HEADER.test(part))
  const parts = hasSceneHeaders ? explicit : normalized.split(/\n\s*\n+/u).filter((part) => part.trim())
  const scenes = parts.map(sceneDraft)
  return parseVideoStoryboardDraft({ schemaVersion: 1, scenes }).scenes
}

function sceneDraft(source: string, sceneIndex: number): VideoStoryboardSceneDraft {
  const lines = source.split('\n').map((line) => line.trim()).filter(Boolean)
  const first = lines[0]
  const title = SCENE_HEADER.test(first) ? first.slice(0, 240) : `场景 ${sceneIndex + 1}`
  const body = SCENE_HEADER.test(first) && lines.length > 1 ? lines.slice(1).join('\n') : source
  const parts = splitAtHeaders(body, SHOT_HEADER)
  return {
    title, summary: source.slice(0, 2000),
    shots: parts.map((prompt, index) => ({ title: `镜头 ${index + 1}`, prompt: prompt.trim(), durationMs: shotDuration(prompt) }))
  }
}

function splitAtHeaders(value: string, header: RegExp): string[] {
  const chunks: string[] = []
  let lines: string[] = []
  for (const line of value.split('\n')) {
    if (header.test(line.trim()) && lines.length) { chunks.push(lines.join('\n').trim()); lines = [] }
    lines.push(line)
  }
  if (lines.length) chunks.push(lines.join('\n').trim())
  return chunks.filter(Boolean)
}

function shotDuration(prompt: string): number {
  const explicit = /(?:\[\s*|(?:时长|duration)\s*[:：]\s*)(\d+(?:\.\d+)?)\s*(?:秒|s(?:ec(?:onds?)?)?)\s*\]?/iu.exec(prompt)
  if (explicit) return Math.round(Number(explicit[1]) * 1000)
  // This is an editable reading-length estimate. Only a reviewed director draft
  // can assign intentional timing; supplied durations are never silently clamped.
  const units = (prompt.match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu) ?? []).length
  return Math.min(12_000, Math.max(2_000, Math.ceil(units / 4) * 1000))
}
