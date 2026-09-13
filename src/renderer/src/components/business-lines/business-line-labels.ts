import { createDefaultBusinessLines, type BusinessLineDefinition } from '../../../../shared/business-line-types'

export function businessLineLabel(line: BusinessLineDefinition, language: 'zh' | 'en'): string {
  if (language === 'zh' || line.origin === 'custom') return line.name
  const original = createDefaultBusinessLines().find((item) => item.id === line.id)
  if (line.name !== original?.name) return line.name
  return { assistant: 'Assistant', studio: 'Projects', video: 'Video' }[line.builtinMode ?? 'assistant']
}

export function routingPreferenceLabel(value: BusinessLineDefinition['routingPreference'], language: 'zh' | 'en'): string {
  const names = language === 'zh'
    ? { balanced: '均衡', quality: '质量优先', cost: '成本优先', speed: '速度优先' }
    : { balanced: 'Balanced', quality: 'Quality', cost: 'Cost', speed: 'Speed' }
  return names[value]
}
