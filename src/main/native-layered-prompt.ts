import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { SessionMeta } from '../shared/types'
import type { StableMessagePayload } from './stable-message-payload'
import { buildIdeDocumentContextPrompt } from './ide/ide-document-context'
import { buildEffectiveMemoryPrompt } from './memory/memory-retriever'
import { buildDigitalWorkerMemoryPrompt } from './digital-worker/worker-memory'
import { buildDigitalWorkerExecutionPrompt } from './digital-worker/worker-execution-prompt'
import { getSettings } from './settings'
import { buildSkillInvocationPrompt } from './skill/skill-invocation'

export interface LayeredPayloadResult {
  payload: StableMessagePayload
  hasMemoryContext: boolean
}

export async function augmentNativePayloadWithLayeredMemory(
  payload: StableMessagePayload,
  meta: SessionMeta,
  workerRootDir?: string
): Promise<LayeredPayloadResult> {
  if (!payload.text.trim() && payload.images.length === 0 && payload.documents.length === 0) {
    return { payload, hasMemoryContext: false }
  }
  const workerRoot = workerRootDir ?? process.env.CAOGEN_USER_DATA_DIR ?? ''
  const workerExecution = meta.digitalWorkerBinding?.kind === 'assigned'
    ? buildDigitalWorkerExecutionPrompt(workerRoot, meta)
    : ''
  const workerMemory = meta.digitalWorkerBinding?.kind === 'assigned'
    ? await buildDigitalWorkerMemoryPrompt(workerRoot, meta)
    : ''
  let skillPrompt = ''
  let memory = ''
  let ideDocumentContext = ''
  try {
    const projectRoot = meta.sourceCwd ?? meta.cwd
    skillPrompt = buildSkillInvocationPrompt({
      enabled: getSettings().autoSkillLearningEnabled,
      projectRoot,
      query: payload.text,
      maxSkills: 2
    })
    memory = await buildEffectiveMemoryPrompt({
      rootDir: process.env.CAOGEN_MEMORY_DIR || resolve(homedir(), '.caogen', 'memory'),
      query: payload.text,
      projectRoot,
      limit: 6
    })
    ideDocumentContext = buildIdeDocumentContextPrompt(meta.id)
  } catch (error) {
    console.error('[caogen] layered memory retrieval failed:', error)
  }
  // Retrieval awaits other stores. A reassignment, role update or permission
  // change during that work must not publish context from the earlier Worker.
  const currentWorkerExecution = meta.digitalWorkerBinding?.kind === 'assigned'
    ? buildDigitalWorkerExecutionPrompt(workerRoot, meta)
    : ''
  if (currentWorkerExecution !== workerExecution) {
    throw new Error('数字员工岗位、分配或执行约束在准备上下文时变化，请重试')
  }
  const hasMemoryContext = Boolean(memory.trim() || workerMemory.trim())
  if (!workerExecution.trim() && !hasMemoryContext && !skillPrompt.trim() && !ideDocumentContext.trim()) {
    return { payload, hasMemoryContext: false }
  }
  return {
    payload: {
      ...payload,
      text: [workerExecution, skillPrompt, ideDocumentContext, memory, workerMemory, '## Current User Request', payload.text]
        .filter((item) => item.trim().length > 0)
        .join('\n\n')
    },
    hasMemoryContext
  }
}
