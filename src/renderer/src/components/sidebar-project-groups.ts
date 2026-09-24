import type { HistoryEntry, Project, ProjectWorkspace, SessionMeta } from '../../../shared/types'

/** Retained only for legacy store compatibility; projects are no longer a user-facing sidebar surface. */
export type SidebarProjectSort = 'recent' | 'name'

export type SidebarEntry =
  | { kind: 'active'; id: string; meta: SessionMeta; history?: HistoryEntry; pendingCount: number }
  | { kind: 'history'; id: string; history: HistoryEntry }

export type ActiveSidebarEntry = Extract<SidebarEntry, { kind: 'active' }>

export interface ProjectGroup {
  key: string
  kind: 'canonical' | 'legacy'
  projectId?: string
  label: string
  path: string
  entries: SidebarEntry[]
  updatedAt: number
  archived?: boolean
  unassigned?: boolean
  workspace?: ProjectWorkspace
  legacyProject?: Project
}

interface BuildProjectGroupsInput {
  entries: SidebarEntry[]
  legacyProjects: Project[]
  projectSort: SidebarProjectSort
  query: string
  unassignedLabel: string
  workspaces: ProjectWorkspace[]
}

export function sidebarEntryPath(entry: SidebarEntry): string {
  const record = entry.kind === 'active' ? entry.meta : entry.history
  return record.sourceCwd ?? record.cwd
}

export function buildSidebarProjectGroups(input: BuildProjectGroupsInput): {
  projectGroups: ProjectGroup[]
  archivedProjectGroups: ProjectGroup[]
  unassigned: ProjectGroup
  showUnassigned: boolean
} {
  const canonicalGroups = canonicalProjectGroups(input.workspaces)
  const { groups: legacyGroups, groupsByPath } = legacyProjectGroups(input.legacyProjects)
  const unassigned: ProjectGroup = {
    key: '__unassigned__',
    kind: 'legacy',
    label: input.unassignedLabel,
    path: '',
    entries: [],
    updatedAt: 0,
    unassigned: true
  }
  for (const entry of input.entries) {
    const target = resolveProjectGroup(entry, canonicalGroups, legacyGroups, groupsByPath) ?? unassigned
    target.entries.push(entry)
    target.updatedAt = Math.max(
      target.updatedAt,
      entry.kind === 'active' ? entry.meta.createdAt : entry.history.updatedAt
    )
  }
  const query = input.query.trim().toLowerCase()
  const matching = [...canonicalGroups.values(), ...legacyGroups.values()]
    .filter((group) => !query || group.entries.length > 0 ||
      `${group.label}\n${group.path}`.toLowerCase().includes(query))
    .sort((left, right) => input.projectSort === 'name'
      ? left.label.localeCompare(right.label)
      : right.updatedAt - left.updatedAt)
  return {
    projectGroups: matching.filter((group) => !group.archived),
    archivedProjectGroups: matching.filter((group) => group.archived),
    unassigned,
    showUnassigned: !query || unassigned.entries.length > 0 ||
      unassigned.label.toLowerCase().includes(query)
  }
}

function canonicalProjectGroups(workspaces: ProjectWorkspace[]): Map<string, ProjectGroup> {
  const groups = new Map<string, ProjectGroup>()
  for (const workspace of workspaces) {
    if (workspace.status === 'deleted') continue
    const location = workspace.resources.find((resource) => resource.path || resource.uri)
    groups.set(workspace.id, {
      key: `canonical:${workspace.id}`,
      kind: 'canonical',
      projectId: workspace.id,
      label: workspace.name,
      path: location?.path ?? location?.uri ?? '',
      entries: [],
      updatedAt: workspace.updatedAt,
      archived: workspace.status === 'archived',
      workspace
    })
  }
  return groups
}

function legacyProjectGroups(projects: Project[]): {
  groups: Map<string, ProjectGroup>
  groupsByPath: Map<string, ProjectGroup>
} {
  const groups = new Map<string, ProjectGroup>()
  const groupsByPath = new Map<string, ProjectGroup>()
  for (const project of projects) {
    const group: ProjectGroup = {
      key: `legacy:${project.id}`,
      kind: 'legacy',
      projectId: project.id,
      label: project.name,
      path: project.path,
      entries: [],
      updatedAt: project.lastUsedAt,
      archived: project.archived === true,
      legacyProject: project
    }
    groups.set(project.id, group)
    groupsByPath.set(project.path, group)
  }
  return { groups, groupsByPath }
}

function resolveProjectGroup(
  entry: SidebarEntry,
  canonical: Map<string, ProjectGroup>,
  legacy: Map<string, ProjectGroup>,
  legacyByPath: Map<string, ProjectGroup>
): ProjectGroup | undefined {
  const record = entry.kind === 'active' ? entry.meta : entry.history
  if (record.unassigned) return undefined
  if (record.workspaceId) {
    let group = canonical.get(record.workspaceId)
    if (!group) {
      group = {
        key: `canonical:${record.workspaceId}`,
        kind: 'canonical',
        projectId: record.workspaceId,
        label: record.workspaceId,
        path: '',
        entries: [],
        updatedAt: 0
      }
      canonical.set(record.workspaceId, group)
    }
    return group
  }
  if (record.projectId) {
    let group = legacy.get(record.projectId)
    if (!group) {
      const path = sidebarEntryPath(entry)
      const pathSegments = path.split(/[\\/]/u).filter(Boolean)
      group = {
        key: `legacy:${record.projectId}`,
        kind: 'legacy',
        projectId: record.projectId,
        label: pathSegments.at(-1) ?? record.projectId,
        path,
        entries: [],
        updatedAt: 0
      }
      legacy.set(record.projectId, group)
      if (path) legacyByPath.set(path, group)
    }
    return group
  }
  return legacyByPath.get(sidebarEntryPath(entry))
}
