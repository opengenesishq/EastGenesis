export interface WslPreferences { mode: 'host' | 'wsl'; distribution?: string }
export interface WslDistribution { name: string; state: string; version: 1 | 2; isDefault: boolean }
export interface WslStatus {
  platform: string; checkedAt: number; available: boolean
  distributions: WslDistribution[]; error?: string
}
export interface WslExecutionBinding {
  kind: 'wsl'; schemaVersion: 1; distribution: string
  hostCwd: string; guestCwd: string; guestRootIdentity: string; hostRootIdentity: string
}
export type ExecutionEnvironmentBinding = { kind: 'host' } | WslExecutionBinding
export type ExecutionEnvironmentSelection = { kind: 'host' } | { kind: 'wsl'; distribution: string }
export interface WslApi {
  inspectWsl(): Promise<WslStatus>
  validateWslDirectory(input: { distribution: string; cwd: string }): Promise<WslExecutionBinding>
}
export function normalizeWslPreferences(value: unknown): WslPreferences {
  if (!value || typeof value !== 'object' || (value as WslPreferences).mode !== 'wsl') return { mode: 'host' }
  const distribution = normalizeWslDistributionName((value as WslPreferences).distribution)
  return { mode: 'wsl', ...(distribution ? { distribution } : {}) }
}
export function normalizeWslDistributionName(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : undefined
}
