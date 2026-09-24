import { createHash } from 'node:crypto'
import type { PluginCatalogDocument, PluginCatalogSelection } from '../../shared/plugin-catalog-types'

export const CATALOG_LIMITS = { catalogBytes: 2 * 1024 * 1024, archiveBytes: 20 * 1024 * 1024, expandedBytes: 50 * 1024 * 1024, files: 5000, depth: 20, sources: 10, packages: 500, releases: 20 }
export const catalogDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const archiveDigest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
export const catalogId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value) || value.includes('..')) throw new Error('目录标识无效。')
  return value
}
export const catalogHash = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('目录摘要无效。')
  return value
}
export function catalogText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error(`${label}无效。`)
  return value.trim()
}
export function catalogRecord(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('目录参数或协议字段无效。')
  return value as Record<string, unknown>
}
export function catalogUrl(value: unknown): string {
  const raw = catalogText(value, 2048, 'HTTPS 地址'), url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || /[\s\\]/.test(raw)) throw new Error('目录需使用不含凭据、查询参数或片段的 HTTPS 地址。')
  return url.href
}
export function catalogVersion(value: unknown): string {
  const text = catalogText(value, 80, '固定版本')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.+_-]*$/.test(text) || /^(latest|head|main|master|stable|dev|next)$/i.test(text)) throw new Error('请选择明确的固定版本。')
  return text
}
export function parseCatalog(value: unknown, sourceUrl: string): PluginCatalogDocument {
  const row = catalogRecord(value, ['schemaVersion', 'name', 'packages'])
  if (row.schemaVersion !== 1 || !Array.isArray(row.packages) || row.packages.length > CATALOG_LIMITS.packages) throw new Error('目录版本或条目数量不支持。')
  const names = new Set<string>(), origin = new URL(catalogUrl(sourceUrl)).origin
  return { schemaVersion: 1, name: catalogText(row.name, 120, '目录名称'), packages: row.packages.map(value => {
    const item = catalogRecord(value, ['id', 'name', 'summary', 'kind', 'releases']), id = catalogId(item.id)
    if (names.has(id) || !['plugin', 'skill', 'agent', 'mcp'].includes(item.kind as string) || !Array.isArray(item.releases) || !item.releases.length || item.releases.length > CATALOG_LIMITS.releases) throw new Error('目录条目重复或发行版无效。')
    names.add(id); const versions = new Set<string>()
    return { id, name: catalogText(item.name, 120, '插件名称'), summary: catalogText(item.summary, 1600, '插件说明'), kind: item.kind as PluginCatalogDocument['packages'][number]['kind'], releases: item.releases.map(value => {
      const release = catalogRecord(value, ['version', 'archiveUrl', 'archiveSha256', 'archiveBytes', 'description']), version = catalogVersion(release.version), archiveUrl = catalogUrl(release.archiveUrl)
      if (versions.has(version) || new URL(archiveUrl).origin !== origin || !Number.isSafeInteger(release.archiveBytes) || (release.archiveBytes as number) <= 0 || (release.archiveBytes as number) > CATALOG_LIMITS.archiveBytes) throw new Error('发行版须为唯一固定版本、同源 HTTPS 下载及有效大小。')
      versions.add(version)
      return { version, archiveUrl, archiveSha256: catalogHash(release.archiveSha256), archiveBytes: release.archiveBytes as number, ...(release.description === undefined ? {} : { description: catalogText(release.description, 16000, '版本说明') }) }
    }) }
  }) }
}
export function parseCatalogSelection(value: unknown): PluginCatalogSelection {
  const row = catalogRecord(value, ['sourceId', 'packageId', 'version', 'archiveSha256', 'snapshotDigest'])
  return { sourceId: catalogId(row.sourceId), packageId: catalogId(row.packageId), version: catalogVersion(row.version), archiveSha256: catalogHash(row.archiveSha256), snapshotDigest: catalogHash(row.snapshotDigest) }
}
