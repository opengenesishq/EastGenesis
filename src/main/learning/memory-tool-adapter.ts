import type { LearningRecord } from '../../shared/learning-types'
import { createLearningDraft } from './learning-lifecycle'
import { resolveDefaultLearningRoot } from './learning-store'
import { projectLearningNamespace } from '../project-aggregate/project-memory-adapter'
import { join } from 'node:path'

const MEMORY_LAYERS = new Set(['working', 'project', 'user'])

export async function proposeModelMemoryDraft(
  projectRoot: string,
  args: Record<string, unknown>,
  context: { projectId?: string; userDataRoot?: string } = {}
): Promise<LearningRecord> {
  const layer = requiredText(args.layer, 'layer')
  if (!MEMORY_LAYERS.has(layer)) throw new Error(`无效记忆层级: ${layer}`)
  const sourceLabel = requiredText(args.source, 'source')
  const tags = stringList(args.tags)
  const namespace = context.projectId ? projectLearningNamespace(context.projectId) : projectRoot
  const learningRoot = await resolveDefaultLearningRoot(projectRoot,
    context.userDataRoot ? join(context.userDataRoot, 'learning') : undefined)
  return createLearningDraft(namespace, learningRoot, {
    kind: 'memory',
    source: 'openai-tool:memory_add',
    confidence: 0.7,
    payload: {
      type: 'memory',
      memoryKind: `requested-${layer}`,
      title: requiredText(args.title, 'title'),
      body: requiredText(args.body, 'body'),
      reason: `模型提议的 ${layer} 记忆；来源标签: ${sourceLabel}${tags.length > 0 ? `；标签: ${tags.join(', ')}` : ''}`
    }
  }, {
    actor: { type: 'model', id: 'openai-tool', source: 'memory_add' }
  })
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少参数: ${field}`)
  return value.trim()
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
}
