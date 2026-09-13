import { createHash } from 'node:crypto'
import type { PersonalTaskSubmitInput } from '../../shared/personal-task-types'
import { isBusinessLineId } from '../../shared/business-line-types'

const INPUT_KEYS = new Set([
  'clientRequestId', 'text', 'businessLineId', 'providerId', 'model',
  'routingScope', 'driveMode', 'taskStrategy', 'budgetUsd'
])

export class PersonalTaskSubmissionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PersonalTaskSubmissionError'
  }
}

export function personalTaskRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,199}$/.test(value)) {
    throw new PersonalTaskSubmissionError('PERSONAL_TASK_INVALID_REQUEST_ID', '个人任务提交标识无效')
  }
  return value
}

export function normalizePersonalTaskInput(value: unknown): PersonalTaskSubmitInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('提交参数必须是对象')
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some((key) => !INPUT_KEYS.has(key))) invalid('提交参数含不受支持的字段')
  const businessLineId = raw.businessLineId ?? 'assistant'
  if (!isBusinessLineId(businessLineId)) invalid('业务线标识无效')
  const input: PersonalTaskSubmitInput = {
    clientRequestId: personalTaskRequestId(raw.clientRequestId),
    text: requiredText(raw.text, '任务内容', 20_000),
    businessLineId,
    ...optionalTextField(raw, 'providerId', 200),
    ...optionalTextField(raw, 'model', 512),
    ...optionalEnumField(raw, 'routingScope', ['fixed', 'provider', 'global'] as const),
    ...optionalEnumField(raw, 'driveMode', ['spark', 'core', 'forge', 'command', 'genesis'] as const),
    ...optionalEnumField(raw, 'taskStrategy', ['view', 'plan', 'execute'] as const)
  }
  if (raw.budgetUsd !== undefined) {
    if (typeof raw.budgetUsd !== 'number' || !Number.isFinite(raw.budgetUsd) || raw.budgetUsd < 0) invalid('预算无效')
    input.budgetUsd = raw.budgetUsd
  }
  return input
}

export function personalTaskInputDigest(input: PersonalTaskSubmitInput): string {
  return createHash('sha256').update(JSON.stringify(normalizePersonalTaskInput(input))).digest('hex')
}

export function personalTaskCanonicalRequestId(clientRequestId: string): string {
  return `personal-task:${createHash('sha256').update(personalTaskRequestId(clientRequestId)).digest('hex')}`
}

export function personalTaskErrorView(error: unknown): { code: string; message: string } {
  const candidate = error as { code?: unknown; message?: unknown } | null
  return {
    code: typeof candidate?.code === 'string' ? candidate.code.slice(0, 200) : 'PERSONAL_TASK_SUBMISSION_FAILED',
    message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
  }
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') invalid(`${label}必须是文字`)
  const text = value.trim()
  if (!text || text.length > max || /[\0\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) invalid(`${label}为空或过长`)
  return text
}

function optionalTextField<K extends string>(raw: Record<string, unknown>, key: K, max: number): Partial<Record<K, string>> {
  return raw[key] === undefined ? {} : { [key]: requiredText(raw[key], key, max) } as Record<K, string>
}

function optionalEnumField<K extends string, V extends string>(
  raw: Record<string, unknown>, key: K, allowed: readonly V[]
): Partial<Record<K, V>> {
  const value = raw[key]
  if (value === undefined) return {}
  if (typeof value !== 'string' || !allowed.includes(value as V)) invalid(`${key}无效`)
  return { [key]: value } as Record<K, V>
}

function invalid(message: string): never {
  throw new PersonalTaskSubmissionError('PERSONAL_TASK_INVALID_INPUT', message)
}
