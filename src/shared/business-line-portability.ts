import { parseBusinessLine, type BusinessLineDefinition } from './business-line-types'

const DEFINITION_FIELDS = new Set(['schemaVersion', 'id', 'origin', 'builtinMode', 'name', 'objective', 'workflow', 'deliverables', 'routingPreference', 'enabled', 'order', 'taskBudgetUsd', 'requiredCapabilities', 'acceptanceCriteria', 'roleInstructions', 'toolScope', 'workSurfaces'])

export function exportBusinessLine(line: BusinessLineDefinition): string {
  const definition = parseBusinessLine(line)
  if (!definition) throw new Error('业务线配置无效')
  return JSON.stringify({ kind: 'caogen.business-line', schemaVersion: 1, definition }, null, 2)
}

/** Imports always produce a new custom draft; they cannot overwrite built-in identity or carry credentials. */
export function importBusinessLine(text: string, newId: string): BusinessLineDefinition {
  if (text.length > 128_000) throw new Error('业务线配置文件超过 128 KB')
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('业务线配置文件格式无效')
  const envelope = value as Record<string, unknown>
  if (envelope.kind !== 'caogen.business-line' || envelope.schemaVersion !== 1) throw new Error('不支持的业务线配置格式或版本')
  const row = envelope.definition
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('缺少业务线定义')
  if (Object.keys(row).some((key) => !DEFINITION_FIELDS.has(key))) throw new Error('业务线配置只能包含定义字段，不接受连接或密钥')
  const parsed = parseBusinessLine(row)
  if (!parsed) throw new Error('业务线定义校验失败')
  return copyBusinessLine(parsed, newId, parsed.name)
}

export function copyBusinessLine(line: BusinessLineDefinition, id: string, name: string): BusinessLineDefinition {
  const { builtinMode: _builtinMode, ...definition } = line
  const copy = parseBusinessLine({ ...definition, id, name, origin: 'custom', enabled: true })
  if (!copy) throw new Error('业务线副本格式无效')
  return copy
}
