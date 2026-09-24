export interface QuickbarSettings {
  defaultTarget: 'auto' | 'current' | 'new'
  includeOcr: boolean
}

export function normalizeQuickbarSettings(value: unknown): QuickbarSettings {
  const raw = value && typeof value === 'object' ? value as Partial<QuickbarSettings> : {}
  return {
    defaultTarget: raw.defaultTarget === 'current' || raw.defaultTarget === 'new' ? raw.defaultTarget : 'auto',
    includeOcr: raw.includeOcr === true
  }
}
