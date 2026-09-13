import { isBusinessLineId } from '../shared/business-line-types'

/** Read validation preserves historical identity even after a line is disabled or renamed. */
export function storedBusinessLineId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (!isBusinessLineId(value)) throw new Error('业务线归属 ID 格式无效')
  return value
}

/** New descendants inherit their durable parent, independently from the navigation selection. */
export function newBusinessLineId(explicit: unknown, inherited?: string, fallback = 'studio'): string {
  const requested = storedBusinessLineId(explicit)
  if (requested && inherited && requested !== inherited) throw new Error('业务线归属与父任务或生产不一致')
  return inherited ?? requested ?? fallback
}

export function assertSameBusinessLine(explicit: unknown, stored: string | undefined, fallback = 'studio'): void {
  const requested = storedBusinessLineId(explicit)
  if (requested && requested !== (stored ?? fallback)) throw new Error('已有实体不能更换业务线归属')
}
