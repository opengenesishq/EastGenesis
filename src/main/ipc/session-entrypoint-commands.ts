import type { PersonalTaskCommand } from '../../shared/personal-task-types'
import type { SessionDiscoveryCommand } from '../../shared/session-entrypoint-types'
import { normalizePersonalTaskInput, personalTaskRequestId } from '../personal-task/personal-task-input'
import { normalizeSessionQueryInput } from '../session-query'

/** Shared parsing boundary for the two closed session-entrypoint domains. */
export function parsePersonalTaskCommand(raw: unknown): PersonalTaskCommand {
  const command = commandRecord(raw)
  if (command.kind === 'submit') {
    exactFields(command, ['kind', 'input'])
    return { kind: 'submit', input: normalizePersonalTaskInput(command.input) }
  }
  if (command.kind === 'get_submission') {
    exactFields(command, ['kind', 'clientRequestId'])
    return { kind: 'get_submission', clientRequestId: personalTaskRequestId(command.clientRequestId) }
  }
  throw new Error('Personal task command kind is invalid')
}

export function parseSessionDiscoveryCommand(raw: unknown): SessionDiscoveryCommand {
  const command = commandRecord(raw)
  if (command.kind === 'list_active') {
    exactFields(command, ['kind'])
    return { kind: 'list_active' }
  }
  if (command.kind === 'query') {
    exactFields(command, ['kind', 'input'])
    return { kind: 'query', input: normalizeSessionQueryInput(command.input) }
  }
  throw new Error('Session discovery command kind is invalid')
}

function commandRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Session entrypoint command must be an object')
  return raw as Record<string, unknown>
}

function exactFields(command: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(command).some((field) => !allowed.includes(field))) throw new Error('Session entrypoint command contains an unknown field')
}
