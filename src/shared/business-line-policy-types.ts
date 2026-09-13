import type { TaskStrategy } from './task-plan-types'

export type BusinessLineRequiredCapability = 'tools' | 'vision'
export interface BusinessLineExecutionDefaults {
  /** Per-task ceiling in USD; omitted means the existing application budget applies. */
  taskBudgetUsd?: number
  requiredCapabilities?: BusinessLineRequiredCapability[]
  acceptanceCriteria?: string[]
  roleInstructions?: string
  /** Reuses the actual task strategy permission boundary, not a prompt-only tool restriction. */
  toolScope?: TaskStrategy
}

export function parseBusinessLinePolicy(row: Record<string, unknown>): BusinessLineExecutionDefaults | null {
  if (!validBudget(row.taskBudgetUsd) || !validCapabilities(row.requiredCapabilities)) return null
  if (!validCriteria(row.acceptanceCriteria) || !validRole(row.roleInstructions)) return null
  if (row.toolScope !== undefined && !['view', 'plan', 'execute'].includes(String(row.toolScope))) return null
  return {
    ...(row.taskBudgetUsd === undefined ? {} : { taskBudgetUsd: row.taskBudgetUsd as number }),
    ...(row.requiredCapabilities === undefined ? {} : { requiredCapabilities: [...new Set(row.requiredCapabilities as BusinessLineRequiredCapability[])] }),
    ...(row.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: (row.acceptanceCriteria as string[]).map((value) => value.trim()) }),
    ...(row.roleInstructions === undefined ? {} : { roleInstructions: (row.roleInstructions as string).trim() }),
    ...(row.toolScope === undefined ? {} : { toolScope: row.toolScope as TaskStrategy })
  }
}

function validBudget(value: unknown): boolean { return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1_000_000) }
function validCapabilities(value: unknown): boolean { return value === undefined || (Array.isArray(value) && value.length <= 2 && value.every((entry) => entry === 'tools' || entry === 'vision')) }
function validCriteria(value: unknown): boolean { return value === undefined || (Array.isArray(value) && value.length <= 40 && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0 && entry.length <= 1000 && !entry.includes('\0'))) }
function validRole(value: unknown): boolean { return value === undefined || (typeof value === 'string' && value.length <= 8000 && !value.includes('\0')) }
