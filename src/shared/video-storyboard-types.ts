export interface VideoStoryboardShotDraft {
  title: string
  prompt: string
  durationMs: number
}

export interface VideoStoryboardSceneDraft {
  title: string
  summary: string
  shots: VideoStoryboardShotDraft[]
}

export interface VideoStoryboardDraft {
  schemaVersion: 1
  scenes: VideoStoryboardSceneDraft[]
}

export const VIDEO_STORYBOARD_LIMITS = { scenes: 100, shots: 300, promptCharacters: 20_000 } as const

export function parseVideoStoryboardDraft(value: unknown): VideoStoryboardDraft {
  const root = record(value, ['schemaVersion', 'scenes'], '分镜草稿')
  if (root.schemaVersion !== 1 || !Array.isArray(root.scenes)) throw new Error('分镜草稿版本或场景列表无效')
  if (root.scenes.length < 1 || root.scenes.length > VIDEO_STORYBOARD_LIMITS.scenes) throw new Error('分镜草稿须包含 1–100 个场景')
  const scenes = root.scenes.map(parseScene)
  if (scenes.reduce((count, scene) => count + scene.shots.length, 0) > VIDEO_STORYBOARD_LIMITS.shots) throw new Error('分镜草稿超过 300 个镜头，请拆分为多个制作项目')
  return { schemaVersion: 1, scenes }
}

function parseScene(value: unknown): VideoStoryboardSceneDraft {
  const row = record(value, ['title', 'summary', 'shots'], '场景')
  if (!Array.isArray(row.shots) || row.shots.length < 1 || row.shots.length > 300) throw new Error('每个场景须包含 1–300 个镜头')
  return { title: text(row.title, 240, '场景标题'), summary: text(row.summary, 2000, '场景描述'), shots: row.shots.map(parseShot) }
}

function parseShot(value: unknown): VideoStoryboardShotDraft {
  const row = record(value, ['title', 'prompt', 'durationMs'], '镜头')
  if (!Number.isSafeInteger(row.durationMs) || Number(row.durationMs) < 500 || Number(row.durationMs) > 120_000) throw new Error('镜头时长须为 500–120000 毫秒的整数')
  return { title: text(row.title, 240, '镜头标题'), prompt: text(row.prompt, VIDEO_STORYBOARD_LIMITS.promptCharacters, '镜头提示词'), durationMs: Number(row.durationMs) }
}

function record(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}须为对象`)
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label}包含不支持的字段`)
  return value as Record<string, unknown>
}

function text(value: unknown, limit: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw new Error(`${label}为空或超出长度限制 ${limit}`)
  return value.trim()
}

export function parseVideoStoryboardText(text: string): VideoStoryboardDraft {
  const value = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  return parseVideoStoryboardDraft(JSON.parse(value))
}
