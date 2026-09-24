export interface MemoryPreferences {
  useSharedMemory: boolean
  contributeSharedMemory: boolean
}

export type MemoryOverrides = Partial<MemoryPreferences>

export interface TaskMemoryPreferences {
  defaults: MemoryPreferences
  overrides: MemoryOverrides
  effective: MemoryPreferences
  temporary: boolean
}

export interface MemoryPreferencesApi {
  readTaskMemoryPreferences(sessionId: string): Promise<TaskMemoryPreferences>
  updateTaskMemoryPreferences(sessionId: string, overrides: MemoryOverrides): Promise<TaskMemoryPreferences>
}

export function normalizeMemoryPreferences(input: unknown): MemoryPreferences {
  const value = object(input)
  return {
    useSharedMemory: typeof value.useSharedMemory === 'boolean' ? value.useSharedMemory : true,
    contributeSharedMemory: typeof value.contributeSharedMemory === 'boolean' ? value.contributeSharedMemory : true
  }
}

export function normalizeMemoryOverrides(input: unknown): MemoryOverrides {
  const value = object(input)
  return {
    ...(typeof value.useSharedMemory === 'boolean' ? { useSharedMemory: value.useSharedMemory } : {}),
    ...(typeof value.contributeSharedMemory === 'boolean' ? { contributeSharedMemory: value.contributeSharedMemory } : {})
  }
}

export function validateMemoryOverrides(input: unknown): MemoryOverrides {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.entries(input).some(([key, value]) =>
    !['useSharedMemory', 'contributeSharedMemory'].includes(key) || typeof value !== 'boolean')) {
    throw new Error('记忆覆盖参数无效；使用布尔值，省略字段表示跟随全局设置。')
  }
  return normalizeMemoryOverrides(input)
}

export function resolveMemoryPreferences(defaults: unknown, overrides?: unknown, temporary = false): TaskMemoryPreferences {
  const normalizedDefaults = normalizeMemoryPreferences(defaults)
  const normalizedOverrides = normalizeMemoryOverrides(overrides)
  return {
    defaults: normalizedDefaults,
    overrides: normalizedOverrides,
    effective: temporary ? { useSharedMemory: false, contributeSharedMemory: false } : { ...normalizedDefaults, ...normalizedOverrides },
    temporary
  }
}

function object(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
}
