import type { AppSettings } from '../../shared/types'

/** Route bodies remain unknown until the one shared rule parser in the service.
 * This boundary only parses the exact domain envelope. Save failures can therefore
 * retain their structured invalid/conflict result instead of becoming IPC strings. */
export type ParsedSettingsCommand =
  | { kind: 'get' | 'route-read' }
  | { kind: 'update'; patch: Partial<AppSettings> }
  | { kind: 'route-preview' | 'route-save'; input: unknown }

export function parseSettingsDomainCommand(raw: unknown): ParsedSettingsCommand {
  const command = plainRecord(raw)
  switch (command.kind) {
    case 'get': case 'route-read':
      exactFields(command, ['kind'])
      return { kind: command.kind }
    case 'update':
      exactFields(command, ['kind', 'patch'])
      return { kind: 'update', patch: readSettingsPatch(command.patch) }
    case 'route-preview': case 'route-save':
      exactFields(command, ['kind', 'input'])
      return { kind: command.kind, input: command.input }
    default: throw new Error('设置操作类型无效。')
  }
}

function readSettingsPatch(raw: unknown): Partial<AppSettings> {
  const patch = plainRecord(raw)
  if (Object.hasOwn(patch, 'routingRuleSet')) throw new Error('路由规则必须通过带版本校验的保存入口更新。')
  // All ordinary setting normalization and active-V1 legacy guards remain in
  // the existing settings service, together with its single atomic commit.
  return patch as Partial<AppSettings>
}

function plainRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('设置操作需要对象。')
  const prototype = Object.getPrototypeOf(raw)
  if (prototype !== Object.prototype && prototype !== null) throw new Error('设置操作对象无效。')
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || !Object.getOwnPropertyDescriptor(raw, key)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(raw, key) ?? {}, 'value')) {
      throw new Error('设置操作包含无效字段。')
    }
  }
  return raw as Record<string, unknown>
}

function exactFields(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error('设置操作包含缺失或多余字段。')
  }
}
