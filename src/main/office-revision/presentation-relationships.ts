import { posix } from 'node:path'
import { officeError } from './errors'
import { utf8, type OfficePackage } from './package'
import { xmlSpans, type XmlSpan } from './xml-spans'

export const OFFICE_RELATION = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
export const PACKAGE_RELATION = 'http://schemas.openxmlformats.org/package/2006/relationships'
export interface PackageRelation { node: XmlSpan; target?: string; type: string; id: string }
export function relationshipPart(owner: string): string {
  return owner ? posix.join(posix.dirname(owner), '_rels', `${posix.basename(owner)}.rels`) : '_rels/.rels'
}
export function readPackageRelations(parts: OfficePackage, owner: string): PackageRelation[] {
  const bytes = parts.get(relationshipPart(owner))
  if (!bytes) return []
  const root = xmlSpans(utf8(bytes))[0]
  if (root.name !== 'Relationships' || root.attributes.xmlns !== PACKAGE_RELATION) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '部件关系命名空间不受支持。')
  const ids = new Set<string>()
  return root.children.map(node => {
    const { Id: id, Type: type, Target: raw, TargetMode: mode } = node.attributes
    if (node.name !== 'Relationship' || (node.attributes.xmlns !== undefined && node.attributes.xmlns !== PACKAGE_RELATION) ||
      node.children.length || !id || !type || !raw || ids.has(id) || (mode && !['Internal', 'External'].includes(mode))) {
      officeError('OFFICE_UNSUPPORTED_STRUCTURE', '部件关系缺失或重复。')
    }
    ids.add(id)
    if (mode === 'External') return { node, type, id }
    let decoded: string
    try { decoded = decodeURIComponent(raw) } catch { return officeError('OFFICE_UNSUPPORTED_STRUCTURE', '部件关系路径编码无效。') }
    if (/[\\?#:\u0000-\u001f]/.test(decoded)) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '部件关系路径无效。')
    const target = decoded.startsWith('/') ? decoded.slice(1) : posix.normalize(posix.join(posix.dirname(owner), decoded))
    if (target.startsWith('../') || !parts.has(target)) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '页面关联部件缺失或越界。')
    return { node, target, type, id }
  })
}

function graph(parts: OfficePackage): Map<string, string[]> {
  const owners = ['', ...[...parts.keys()].filter(name => !name.endsWith('.rels'))]
  return new Map(owners.map(owner => [owner, readPackageRelations(parts, owner).flatMap(relation => relation.target ? [relation.target] : [])]))
}
function reachable(edges: Map<string, string[]>, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>(), pending = [...roots]
  while (pending.length) {
    const item = pending.pop()!
    if (seen.has(item)) continue
    seen.add(item); pending.push(...edges.get(item) ?? [])
  }
  return seen
}

/** Remove selected pages and only their exclusive dependencies, including notes
 * and media. Keep every shared resource and unrelated pre-existing package part. */
export function removePresentationPages(original: OfficePackage, output: OfficePackage, removed: string[], caches: string[] = []): string[] {
  if (!removed.length && !caches.length) return []
  const candidates = reachable(graph(original), [...removed, ...caches])
  const kept = reachable(graph(output), ['', ...[...output.keys()].filter(name => !name.endsWith('.rels') && !candidates.has(name))])
  if (removed.some(part => kept.has(part))) officeError('OFFICE_UNSUPPORTED_STRUCTURE', '其他页面或部件仍引用待删除页面，请先移除该引用后再删除。')
  const deleted: string[] = []
  for (const part of candidates) {
    if (kept.has(part)) continue
    for (const name of [part, relationshipPart(part)]) if (output.delete(name)) deleted.push(name)
  }
  return deleted
}
