export interface SuggestedPromptSettings {
  examples: boolean
  contextual: boolean
}

export function normalizeSuggestedPrompts(value: unknown): SuggestedPromptSettings {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
  return { examples: record.examples !== false, contextual: record.contextual !== false }
}
