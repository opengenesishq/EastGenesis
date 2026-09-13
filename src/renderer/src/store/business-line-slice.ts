import type { AppSettings, CreateSessionOptions, SessionMeta } from '../../../shared/types'
import { getBusinessLines, parseBusinessLine, resolveBusinessLineId, resolveSelectedBusinessLine, type BusinessLineDefinition } from '../../../shared/business-line-types'
import type { AppStore } from '../store'
import { startConfiguredBusinessLineTask } from './business-line-task-start'

export interface BusinessLineSlice {
  selectBusinessLine(id: string): Promise<void>
  saveBusinessLine(line: BusinessLineDefinition): Promise<void>
  reorderBusinessLine(id: string, direction: -1 | 1): Promise<void>
  setBusinessLineEnabled(id: string, enabled: boolean): Promise<void>
  startBusinessLineTask(id: string, prompt: string): Promise<string>
}

type SetState = (patch: Partial<AppStore> | ((state: AppStore) => Partial<AppStore>)) => void

export function createBusinessLineSlice(set: SetState, get: () => AppStore): BusinessLineSlice {
  return {
    async selectBusinessLine(id) {
      const state = get()
      const line = getBusinessLines(state.settings).find((candidate) => candidate.id === id && candidate.enabled)
      if (!line) throw new Error('业务线不存在或已停用')
      await state.updateSettings({ selectedBusinessLineId: line.id, experienceMode: line.builtinMode ?? 'assistant' })
      const settings = get().settings
      if (resolveSelectedBusinessLine(settings).id !== id) throw new Error('业务线不存在或已停用，请检查业务线管理')
      set({ experienceMode: settings.experienceMode, view: 'list', showNewSession: false, showTaskRecovery: false, studioSurface: 'workspace' })
    },
    async saveBusinessLine(line) {
      const parsed = parseBusinessLine(line)
      if (!parsed) throw new Error('请检查业务线名称、流程和成果格式')
      const lines = getBusinessLines(get().settings)
      const existing = lines.findIndex((candidate) => candidate.id === line.id)
      if (existing >= 0) lines[existing] = { ...parsed, order: lines[existing].order, enabled: lines[existing].enabled }
      else lines.push({ ...parsed, order: lines.length })
      await get().updateSettings({ businessLines: lines })
      set({ experienceMode: get().settings.experienceMode })
    },
    async reorderBusinessLine(id, direction) {
      const lines = getBusinessLines(get().settings)
      const index = lines.findIndex((line) => line.id === id)
      const destination = index + direction
      if (index < 0 || destination < 0 || destination >= lines.length) return
      ;[lines[index], lines[destination]] = [lines[destination], lines[index]]
      await get().updateSettings({ businessLines: lines.map((line, order) => ({ ...line, order })) })
    },
    async setBusinessLineEnabled(id, enabled) {
      const lines = getBusinessLines(get().settings).map((line) => line.id === id ? { ...line, enabled } : line)
      if (!lines.some((line) => line.enabled)) throw new Error('请至少保留一条启用的业务线')
      await get().updateSettings({ businessLines: lines })
      set({ experienceMode: get().settings.experienceMode })
    },
    async startBusinessLineTask(id, prompt) {
      const state = get()
      const line = getBusinessLines(state.settings).find((candidate) => candidate.id === id && candidate.enabled)
      if (!line || !prompt.trim()) throw new Error('请输入任务，并选择已启用的业务线')
      return startConfiguredBusinessLineTask(state, line, prompt)
    }
  }
}

export function businessLineCreateOptions(options: CreateSessionOptions, settings: AppSettings): CreateSessionOptions {
  if (options.businessLineId || options.resumeSdkSessionId || options.forkFromSdkSessionId) return options
  const businessLineId = options.workspaceId || options.projectId || options.experienceModeOverride
    ? resolveBusinessLineId(options) : resolveSelectedBusinessLine(settings).id
  return { ...options, businessLineId }
}

export function businessLineSessionSettings(settings: AppSettings, meta: Partial<SessionMeta>): AppSettings {
  const id = resolveBusinessLineId(meta)
  return getBusinessLines(settings).some((line) => line.id === id && line.enabled)
    ? { ...settings, selectedBusinessLineId: id }
    : settings
}
