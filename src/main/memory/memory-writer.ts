import type { MemoryLayer } from './memory-manager'
import { proposeMemoryDraft, type ProjectMemoryDraft } from '../memoryStore'
import type { SessionMeta } from '../../shared/types'
import { currentTaskMemoryPreferences, withTaskMemoryPreferences } from './memory-preferences'

export interface MemoryExtractionInput {
  rootDir: string
  text: string
  projectRoot?: string
  projectId?: string
  source: string
  defaultLayer?: MemoryLayer
  sessionMeta?: SessionMeta
}

// 只抽取用户明确要求记住的稳定约定，避免把一次性聊天内容写成长期记忆。
const MEMORY_PATTERNS = [
  /(?:记住|以后|偏好|约定|规范|踩坑|不要再|下次|always|remember|preference|convention)/i,
  /(?:用户纠正|修正为|真实失败点|根因|workaround|gotcha)/i
]

export function shouldExtractMemory(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length >= 12 && MEMORY_PATTERNS.some((pattern) => pattern.test(trimmed))
}

export function summarizeMemoryTitle(text: string): string {
  const first = text.replace(/\s+/g, ' ').trim().slice(0, 80)
  return first || '记忆条目'
}

export async function writeExtractedMemory(input: MemoryExtractionInput): Promise<ProjectMemoryDraft | null> {
  if (!currentTaskMemoryPreferences(input.sessionMeta).effective.contributeSharedMemory) return null
  if (!shouldExtractMemory(input.text)) return null
  if (!input.projectRoot) return null
  const projectRoot = input.projectRoot
  const layer = input.defaultLayer ?? (input.projectRoot ? 'project' : 'user')
  const tags = inferTags(input.text)
  const write = () => proposeMemoryDraft({ projectRoot, projectId: input.projectId }, input.rootDir, {
    kind: `auto-extracted-${layer}`,
    title: summarizeMemoryTitle(input.text),
    body: input.text.trim(),
    source: input.source,
    reason: `自动抽取的 ${layer} 记忆候选，需用户批准后生效${tags.length > 0 ? `；标签: ${tags.join(', ')}` : ''}`
  }, {
    confidence: 0.8,
    actor: { type: 'runtime', id: 'memory-auto-extract', source: input.source }
  })
  return input.sessionMeta ? withTaskMemoryPreferences(input.sessionMeta, write) : write()
}

function inferTags(text: string): string[] {
  const tags: string[] = []
  if (/测试|验证|test|verify/i.test(text)) tags.push('测试')
  if (/风格|命名|style|naming/i.test(text)) tags.push('风格')
  if (/失败|错误|报错|failed|error/i.test(text)) tags.push('踩坑')
  if (/权限|安全|permission|security/i.test(text)) tags.push('安全')
  return tags
}
