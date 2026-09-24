import type { SessionMeta } from '../shared/types'
import type { StableMessagePayload } from './stable-message-payload'
import { buildIdeDocumentContextPrompt } from './ide/ide-document-context'
import { buildEffectiveMemoryPrompt } from './memory/memory-retriever'
import { resolveMemoryRoot } from './memory/memory-root'
import { taskMemoryScope } from './memory/task-memory-scope'
import { buildDigitalWorkerMemoryPrompt } from './digital-worker/worker-memory'
import { buildDigitalWorkerExecutionPrompt } from './digital-worker/worker-execution-prompt'
import { getSettings } from './settings'
import { buildSkillInvocationPrompt } from './skill/skill-invocation'
import { currentTaskMemoryPreferences } from './memory/memory-preferences'

export interface LayeredPayloadResult {
  payload: StableMessagePayload
  hasMemoryContext: boolean
}

export async function augmentNativePayloadWithLayeredMemory(
  payload: StableMessagePayload,
  meta: SessionMeta,
  workerRootDir?: string
): Promise<LayeredPayloadResult> {
  if (process.env.CAOGEN_TEMPORARY_PROFILE_ID) return { payload, hasMemoryContext: false }
  if (!payload.text.trim() && payload.images.length === 0 && payload.documents.length === 0) {
    return { payload, hasMemoryContext: false }
  }
  const environmentPrompt = meta.executionEnvironment?.kind === 'wsl'
    ? `执行环境固定为 WSL2 / ${meta.executionEnvironment.distribution}。命令和 Git 在 Linux 目录 ${meta.executionEnvironment.guestCwd} 执行；文件工具访问同一 Linux 目录，请使用项目内相对路径。不要使用 Windows cmd/PowerShell 命令，不得自行切换发行版或宿主环境。` : ''
  const workerRoot = workerRootDir ?? process.env.CAOGEN_USER_DATA_DIR ?? ''
  const projectRoot = meta.sourceCwd ?? meta.cwd
  const projectId = meta.workspaceId
  const workerExecution = meta.digitalWorkerBinding?.kind === 'assigned'
    ? buildDigitalWorkerExecutionPrompt(workerRoot, meta)
    : ''
  const sharedMemoryAllowed = (): boolean => currentTaskMemoryPreferences(meta).effective.useSharedMemory
  let workerMemory = sharedMemoryAllowed() && meta.digitalWorkerBinding?.kind === 'assigned'
    ? await buildDigitalWorkerMemoryPrompt(workerRoot, meta)
    : ''
  let skillPrompt = ''
  let memory = ''
  let ideDocumentContext = ''
  try {
    skillPrompt = buildSkillInvocationPrompt({
      enabled: getSettings().autoSkillLearningEnabled,
      projectRoot,
      query: payload.text,
      maxSkills: 2
    })
    memory = await buildEffectiveMemoryPrompt({
      rootDir: resolveMemoryRoot(workerRoot),
      query: payload.text,
      ...await taskMemoryScope(meta, workerRoot),
      sharedMemoryAllowed,
      limit: 6
    })
    ideDocumentContext = buildIdeDocumentContextPrompt(meta.id)
  } catch (error) {
    console.error('[caogen] layered memory retrieval failed:', error)
  }
  if (projectId !== meta.workspaceId || projectRoot !== (meta.sourceCwd ?? meta.cwd)) {
    throw new Error('任务所属项目在准备记忆上下文时变化，请重试')
  }
  // Retrieval awaits other stores. A reassignment, role update or permission
  // change during that work must not publish context from the earlier Worker.
  const currentWorkerExecution = meta.digitalWorkerBinding?.kind === 'assigned'
    ? buildDigitalWorkerExecutionPrompt(workerRoot, meta)
    : ''
  if (currentWorkerExecution !== workerExecution) {
    throw new Error('数字员工岗位、分配或执行约束在准备上下文时变化，请重试')
  }
  if (!sharedMemoryAllowed()) workerMemory = ''
  const hasMemoryContext = Boolean(memory.trim() || workerMemory.trim())
  if (!environmentPrompt && !workerExecution.trim() && !hasMemoryContext && !skillPrompt.trim() && !ideDocumentContext.trim()) {
    return { payload, hasMemoryContext: false }
  }
  return {
    payload: {
      ...payload,
      text: [environmentPrompt, workerExecution, skillPrompt, ideDocumentContext, memory, workerMemory, '## Current User Request', payload.text]
        .filter((item) => item.trim().length > 0)
        .join('\n\n')
    },
    hasMemoryContext
  }
}
