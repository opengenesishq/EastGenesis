import type { PluginRegistryItem } from '../../../../shared/plugin-registry-types'

function normalized(path: string): string { return path.replace(/\\/g, '/').replace(/\/+$/, '') }
/** Match the exact imported configuration and active project; never select a namesake. */
export function migrationServiceCandidates(targetPaths: string[], items: PluginRegistryItem[], projectDirectories: Array<string | undefined>): PluginRegistryItem[] {
  const targets = new Set(targetPaths.map(normalized))
  const projectRoots = new Set(projectDirectories.filter((path): path is string => !!path).map(path => `${normalized(path)}/.caogen`))
  return items.filter(item => item.kind === 'mcp' && targets.has(normalized(item.path)) &&
    normalized(item.path) === `${normalized(item.sourceRoot)}/mcp/mcp.json` &&
    (item.sourceKind === 'user' || item.sourceKind === 'project' && projectRoots.has(normalized(item.sourceRoot))))
}
