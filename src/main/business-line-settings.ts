import { getBusinessLines, isBusinessLineId, parseBusinessLine, resolveSelectedBusinessLine, type BusinessLineSettings, type BuiltinBusinessLineMode } from '../shared/business-line-types'

type SettingsInput = BusinessLineSettings & { experienceMode?: BuiltinBusinessLineMode }

/** Settings mutation rejects malformed identities, unsupported versions and duplicates. */
export function validateBusinessLinePatch(patch: BusinessLineSettings): void {
  if (patch.selectedBusinessLineId !== undefined && !isBusinessLineId(patch.selectedBusinessLineId)) {
    throw new Error('Business line selection has an invalid identity')
  }
  if (patch.businessLines === undefined) return
  if (!Array.isArray(patch.businessLines) || patch.businessLines.length > 100) throw new Error('Business line registry must contain at most 100 entries')
  const seen = new Set<string>()
  for (const value of patch.businessLines) {
    const line = parseBusinessLine(value)
    if (!line) throw new Error('Business line definition is invalid or its schema version is unsupported')
    if (seen.has(line.id)) throw new Error('Business line identities must be unique')
    seen.add(line.id)
  }
}

export function normalizeBusinessLineSettings(settings: SettingsInput): Required<BusinessLineSettings> & { experienceMode: BuiltinBusinessLineMode } {
  const businessLines = getBusinessLines({ businessLines: Array.isArray(settings.businessLines) ? settings.businessLines : undefined })
  const selected = resolveSelectedBusinessLine({ ...settings, businessLines })
  return { businessLines, selectedBusinessLineId: selected.id, experienceMode: selected.builtinMode ?? 'assistant' }
}

export function mergeBusinessLineSettings(previous: SettingsInput, patch: SettingsInput): ReturnType<typeof normalizeBusinessLineSettings> {
  const selectedBusinessLineId = patch.selectedBusinessLineId ?? patch.experienceMode ?? previous.selectedBusinessLineId
  return normalizeBusinessLineSettings({ ...previous, ...patch, selectedBusinessLineId })
}
