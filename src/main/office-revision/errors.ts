export type OfficeRevisionErrorCode = 'OFFICE_SCOPE_MISMATCH' | 'OFFICE_BASE_CHANGED' | 'OFFICE_BASE_NOT_HEAD'
  | 'OFFICE_SELECTION_STALE' | 'OFFICE_UNSUPPORTED_STRUCTURE' | 'OFFICE_INCOMPLETE_COVERAGE'
  | 'OFFICE_PLAN_MISMATCH' | 'OFFICE_PLAN_EXPIRED' | 'OFFICE_OUTPUT_CONFLICT'
export class OfficeRevisionError extends Error {
  readonly name = 'OfficeRevisionError'
  constructor(readonly code: OfficeRevisionErrorCode, message: string) { super(`${code}: ${message}`) }
}
export function officeError(code: OfficeRevisionErrorCode, message: string): never { throw new OfficeRevisionError(code, message) }
