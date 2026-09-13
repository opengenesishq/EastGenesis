import type { BusinessLineDefinition } from '../../../../shared/business-line-types'

/**
 * Navigation identity is the durable business-line id. Built-in mode is only
 * an optional projection detail and must not be required for peer custom lines.
 */
export function businessLineNavigationOptionId(line: Pick<BusinessLineDefinition, 'id'>): string {
  return line.id
}
