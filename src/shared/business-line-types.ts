/** Business lines are peers. Their identity is independent of a Project or UI mode. */
import { parseBusinessLinePolicy, type BusinessLineExecutionDefaults } from './business-line-policy-types'
export const BUSINESS_LINE_SCHEMA_VERSION = 1 as const
export type BuiltinBusinessLineMode = 'assistant' | 'studio' | 'video'
export type BusinessLineRoutingPreference = 'balanced' | 'quality' | 'cost' | 'speed'
export type BusinessLineWorkSurface = 'tasks' | 'results' | 'video'

export interface BusinessLineDefinition extends BusinessLineExecutionDefaults {
  schemaVersion: typeof BUSINESS_LINE_SCHEMA_VERSION
  id: string
  origin: 'builtin' | 'custom'
  name: string
  objective: string
  workflow: string[]
  deliverables: string[]
  routingPreference: BusinessLineRoutingPreference
  enabled: boolean
  order: number
  builtinMode?: BuiltinBusinessLineMode
  workSurfaces?: BusinessLineWorkSurface[]
}

export interface BusinessLineSettings {
  /** Missing on pre-registry settings; normalized to the three built-in definitions. */
  businessLines?: BusinessLineDefinition[]
  selectedBusinessLineId?: string
}

export interface BusinessLineBinding {
  /** Durable origin; changing navigation must never reassign an existing task. */
  businessLineId?: string
}

export interface BusinessLineTaskIdentity extends BusinessLineBinding {
  workspaceId?: string
  projectId?: string
  goalId?: string
  workItemId?: string
  experienceModeOverride?: 'assistant' | 'studio'
}

export function createDefaultBusinessLines(): BusinessLineDefinition[] {
  return [
    builtin('assistant', '助手', '处理日常工作，完成可核实的任务', ['理解需求', '执行任务', '核验交付'], ['任务结果']),
    builtin('studio', '项目', '围绕长期目标协作，持续推进项目', ['澄清目标', '计划与执行', '验证与交付'], ['项目成果']),
    builtin('video', '视频', '从创意和剧本制作可交付的视频', ['剧本与分镜', '素材与镜头', '剪辑与交付'], ['成片'])
  ].map((line, order) => ({ ...line, order }))
}

function builtin(id: BuiltinBusinessLineMode, name: string, objective: string, workflow: string[], deliverables: string[]): BusinessLineDefinition {
  return { schemaVersion: 1, id, origin: 'builtin', builtinMode: id, name, objective, workflow, deliverables, routingPreference: 'balanced', enabled: true, order: 0 }
}

export function isBusinessLineId(value: unknown): value is string {
  return typeof value === 'string' && (/^(assistant|studio|video)$/.test(value) || /^business-line:[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value))
}

export function parseBusinessLine(value: unknown): BusinessLineDefinition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (!validDefinitionFields(row)) return null
  const policy = parseBusinessLinePolicy(row)
  if (!policy) return null
  const builtinMode = createDefaultBusinessLines().find((line) => line.id === row.id)?.builtinMode
  if (!validDefinitionIdentity(row, builtinMode)) return null
  return {
    ...policy,
    schemaVersion: 1, id: row.id, origin: builtinMode ? 'builtin' : 'custom',
    name: row.name.trim(), objective: row.objective.trim(),
    workflow: row.workflow.map((item) => item.trim()), deliverables: row.deliverables.map((item) => item.trim()),
    routingPreference: row.routingPreference as BusinessLineRoutingPreference,
    ...(Array.isArray(row.workSurfaces) ? { workSurfaces: [...new Set(row.workSurfaces as BusinessLineWorkSurface[])] } : {}),
    enabled: row.enabled, order: Number(row.order), ...(builtinMode ? { builtinMode } : {})
  }
}

type DefinitionFields = Record<string, unknown> & Pick<BusinessLineDefinition, 'id' | 'name' | 'objective' | 'workflow' | 'deliverables' | 'enabled'>
function validDefinitionFields(row: Record<string, unknown>): row is DefinitionFields {
  return row.schemaVersion === 1 && isBusinessLineId(row.id) && typeof row.enabled === 'boolean'
    && validText(row.name, 80, true) && validText(row.objective, 4000)
    && validTextList(row.workflow) && validTextList(row.deliverables) && validWorkSurfaces(row.workSurfaces)
}

function validDefinitionIdentity(row: Record<string, unknown>, builtinMode?: BuiltinBusinessLineMode): boolean {
  return row.origin === (builtinMode ? 'builtin' : 'custom') && row.builtinMode === builtinMode
    && ['balanced', 'quality', 'cost', 'speed'].includes(String(row.routingPreference))
    && Number.isSafeInteger(row.order) && Number(row.order) >= 0
}

function validText(value: unknown, max: number, required = false): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0') && (!required || Boolean(value.trim()))
}

function validTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 40 && value.every((item) => validText(item, 1000, true))
}

function validWorkSurfaces(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length > 0 && value.length <= 3 && value.every((entry) => ['tasks', 'results', 'video'].includes(entry)))
}

export function getBusinessLineWorkSurfaces(line: BusinessLineDefinition): BusinessLineWorkSurface[] {
  return line.workSurfaces ?? (line.builtinMode === 'video' ? ['video'] : ['tasks', 'results'])
}

/** Invalid legacy entries are ignored without inventing replacement identities. */
export function getBusinessLines(settings: BusinessLineSettings): BusinessLineDefinition[] {
  const lines = new Map(createDefaultBusinessLines().map((line) => [line.id, line]))
  for (const value of settings.businessLines ?? []) {
    const parsed = parseBusinessLine(value)
    if (parsed) lines.set(parsed.id, parsed)
  }
  const sorted = [...lines.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  if (!sorted.some((line) => line.enabled)) sorted.find((line) => line.id === 'assistant')!.enabled = true
  return sorted.map((line, order) => ({ ...line, order }))
}

export function resolveSelectedBusinessLine(settings: BusinessLineSettings & { experienceMode?: BuiltinBusinessLineMode }): BusinessLineDefinition {
  const lines = getBusinessLines(settings).filter((line) => line.enabled)
  return lines.find((line) => line.id === settings.selectedBusinessLineId)
    ?? lines.find((line) => line.id === settings.experienceMode)
    ?? lines[0]
}

export function resolveBusinessLineId(meta: BusinessLineTaskIdentity): string {
  if (isBusinessLineId(meta.businessLineId)) return meta.businessLineId
  if (meta.experienceModeOverride) return meta.experienceModeOverride
  return meta.workspaceId || meta.projectId || meta.goalId || meta.workItemId ? 'studio' : 'assistant'
}
