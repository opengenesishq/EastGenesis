import type { ComputerHistoryFilter, ComputerHistoryPolicy, ComputerHistoryPolicyInput, ComputerHistoryQuery } from '../../shared/computer-history-types'

export const DEFAULT_HISTORY_POLICY: ComputerHistoryPolicy = { enabled: false, paused: false, allowedApps: [], retentionDays: 30, revision: 0 }
export function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
export function isBundleId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{1,199}$/.test(value) }
export function isBrowserBundleId(value: string): boolean {
  return /(?:safari|chrome|chromium|firefox|brave|vivaldi|opera|microsoft\.edgemac|duckduckgo|thebrowser\.browser|browsercompany|zen-browser|waterfox|librewolf|orion)/i.test(value)
}
export function isExcludedBundleId(value: string): boolean { return isBrowserBundleId(value) || /^(?:com\.caogen\.|com\.electron\.)/i.test(value) }
export function parsePolicyInput(raw: unknown): ComputerHistoryPolicyInput {
  if (!isRecord(raw) || Object.keys(raw).some(key => !['expectedRevision', 'enabled', 'paused', 'allowedBundleIds', 'retentionDays', 'consent'].includes(key)) ||
      !Number.isSafeInteger(raw.expectedRevision) || Number(raw.expectedRevision) < 0 || typeof raw.enabled !== 'boolean' || typeof raw.paused !== 'boolean' ||
      !Array.isArray(raw.allowedBundleIds) || raw.allowedBundleIds.length > 100 || !raw.allowedBundleIds.every(isBundleId) ||
      ![7, 30, 90].includes(Number(raw.retentionDays)) || typeof raw.retentionDays !== 'number' || (raw.consent !== undefined && raw.consent !== true)) {
    throw new Error('电脑历史设置参数无效。')
  }
  if (new Set(raw.allowedBundleIds).size !== raw.allowedBundleIds.length || raw.allowedBundleIds.some(isExcludedBundleId)) throw new Error('来源重复或包含暂不支持的应用。')
  if (raw.enabled && raw.allowedBundleIds.length === 0) throw new Error('请至少选择一个允许记录的应用。')
  return raw as unknown as ComputerHistoryPolicyInput
}
export function parseHistoryQuery(raw: unknown, pagination = true): ComputerHistoryQuery {
  const allowed = ['from', 'to', 'bundleId', 'query', 'recordId', ...(pagination ? ['offset', 'limit'] : [])]
  if (!isRecord(raw) || Object.keys(raw).some(key => !allowed.includes(key))) throw new Error('历史筛选参数无效。')
  for (const key of ['from', 'to']) if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < 0)) throw new Error('请选择有效时间范围。')
  if (typeof raw.from === 'number' && typeof raw.to === 'number' && raw.from > raw.to) throw new Error('开始时间不能晚于结束时间。')
  if (raw.bundleId !== undefined && !isBundleId(raw.bundleId)) throw new Error('应用来源无效。')
  if (raw.query !== undefined && (typeof raw.query !== 'string' || raw.query.length > 240)) throw new Error('搜索内容过长。')
  if (raw.recordId !== undefined && (typeof raw.recordId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(raw.recordId))) throw new Error('记录标识无效。')
  if (raw.offset !== undefined && (!Number.isSafeInteger(raw.offset) || Number(raw.offset) < 0 || Number(raw.offset) > 10_000)) throw new Error('分页位置无效。')
  if (raw.limit !== undefined && (!Number.isSafeInteger(raw.limit) || Number(raw.limit) < 1 || Number(raw.limit) > 200)) throw new Error('分页数量无效。')
  return { ...raw } as ComputerHistoryQuery
}
export function matchesHistory(row: { id: string; capturedAt: number; bundleId: string; appName: string; title: string }, filter: ComputerHistoryFilter): boolean {
  return (filter.from === undefined || row.capturedAt >= filter.from) && (filter.to === undefined || row.capturedAt <= filter.to) &&
    (!filter.bundleId || row.bundleId === filter.bundleId) && (!filter.recordId || row.id === filter.recordId) &&
    (!filter.query?.trim() || `${row.appName}\n${row.title}`.toLocaleLowerCase().includes(filter.query.trim().toLocaleLowerCase()))
}
