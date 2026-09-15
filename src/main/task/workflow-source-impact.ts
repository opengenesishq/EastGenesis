import posixPath from 'node:path/posix'
import type { WorkflowArtifactEdgeRecord, WorkflowArtifactRecord } from '../../shared/workflow-types'
import { digest } from './workflow-ledger-codec'
import {
  buildWorkflowChangeImpactPlan,
  type WorkflowChangeImpactInput,
  type WorkflowChangeImpactPlan
} from './workflow-change-impact'
import { parseCodeDiagnostics, parseCodeFile } from '../indexer/parsers/languages'

/** A source file and the Artifact that represents its durable content. */
export interface WorkflowSourceFileInput {
  path: string
  content: string
  artifactId: string
}

export interface WorkflowSourceDependencyRecallInput {
  projectId?: string
  files: readonly WorkflowSourceFileInput[]
  /** Explicit Ledger edges take precedence over parser-derived edges. */
  explicitEdges?: readonly WorkflowArtifactEdgeRecord[]
  observedAt?: number
}

export interface WorkflowSourceDependencyRecall {
  status: 'ready' | 'blocked'
  edges: WorkflowArtifactEdgeRecord[]
  unresolvedReferences: string[]
  ambiguousReferences: string[]
  sourceDigest: string
}

export interface WorkflowSourceChangeImpactInput extends Omit<WorkflowChangeImpactInput, 'edges'> {
  sourceFiles: readonly WorkflowSourceFileInput[]
  explicitEdges?: readonly WorkflowArtifactEdgeRecord[]
  observedAt?: number
}

export interface WorkflowSourceChangeImpactPlan {
  gate: WorkflowSourceDependencyRecall
  plan?: WorkflowChangeImpactPlan
}

/**
 * Resolve local imports against the supplied source snapshot. This is a
 * bounded, pure parser pass: no filesystem/network access and no guessing for
 * aliases, missing files, parser errors, or ambiguous candidates.
 */
export function recallWorkflowSourceDependencies(
  input: WorkflowSourceDependencyRecallInput
): WorkflowSourceDependencyRecall {
  const projectId = normalizeOptional(input.projectId)
  const files = normalizeFiles(input.files)
  const sourceDigest = digest({ schemaVersion: 1, projectId, files: files.map(({ path, artifactId, content }) => ({ path, artifactId, content })) })
  const explicitEdges = input.explicitEdges ?? []
  if (explicitEdges.length > 0) {
    // The durable graph is authoritative. Avoid parser-derived edges changing
    // an already reviewed graph, even if a local source snapshot is partial.
    return {
      status: 'ready',
      edges: [...explicitEdges].sort((left, right) => left.id.localeCompare(right.id)),
      unresolvedReferences: [],
      ambiguousReferences: [],
      sourceDigest
    }
  }

  const byPath = new Map(files.map((file) => [file.path, file]))
  const unresolvedReferences: string[] = []
  const ambiguousReferences: string[] = []
  const edges: WorkflowArtifactEdgeRecord[] = []
  const seen = new Set<string>()
  for (const file of files) {
    let parsed: ReturnType<typeof parseCodeFile>
    try {
      const diagnostics = parseCodeDiagnostics(file.path, file.content)
      if (diagnostics && diagnostics.length > 0) {
        unresolvedReferences.push(`parse-error:${file.path}`)
        continue
      }
      parsed = parseCodeFile(file.path, file.content)
    } catch {
      unresolvedReferences.push(`parse-error:${file.path}`)
      continue
    }
    if (!parsed) continue
    for (const imported of parsed.imports) {
      const localImport = imported.specifier.startsWith('.') || (parsed.language === 'rust' && !imported.specifier.includes('::'))
      if (!localImport) continue // external/package imports are outside this project graph
      const resolution = resolveLocalImport(file.path, imported.specifier, byPath, parsed.language)
      if (resolution.kind === 'missing') {
        unresolvedReferences.push(`missing-import:${file.path}:${imported.specifier}`)
        continue
      }
      if (resolution.kind === 'ambiguous') {
        ambiguousReferences.push(`ambiguous-import:${file.path}:${imported.specifier}:${resolution.candidates.join(',')}`)
        continue
      }
      const target = byPath.get(resolution.path)
      if (!target || target.artifactId === file.artifactId) continue
      // Imported target -> importer: changing the imported source invalidates
      // the file that consumes it. This matches the Artifact Graph planner's
      // propagation direction.
      const key = `${target.artifactId}->${file.artifactId}:${imported.specifier}:${imported.line}`
      if (seen.has(key)) continue
      seen.add(key)
      const edgeInput = {
        schemaVersion: 1 as const,
        fromArtifactId: target.artifactId,
        toArtifactId: file.artifactId,
        relation: 'depends_on' as const,
        ...(projectId ? { projectId } : {}),
        metadata: {
          source: 'lightweight-import-parser',
          fromPath: target.path,
          toPath: file.path,
          rawImport: imported.specifier,
          line: imported.line,
          sourceDigest
        },
        createdAt: finiteObservedAt(input.observedAt),
        updatedAt: finiteObservedAt(input.observedAt)
      }
      edges.push({
        ...edgeInput,
        id: `edge:source:${digest(edgeInput).slice(0, 24)}`
      })
    }
  }
  unresolvedReferences.sort()
  ambiguousReferences.sort()
  edges.sort((left, right) => left.id.localeCompare(right.id))
  return {
    status: unresolvedReferences.length || ambiguousReferences.length ? 'blocked' : 'ready',
    edges,
    unresolvedReferences,
    ambiguousReferences,
    sourceDigest
  }
}

/** Build a planner output only when source resolution passes its fail-closed gate. */
export function buildWorkflowChangeImpactPlanFromSources(input: WorkflowSourceChangeImpactInput): WorkflowSourceChangeImpactPlan {
  const gate = recallWorkflowSourceDependencies({
    projectId: input.projectId,
    files: input.sourceFiles,
    explicitEdges: input.explicitEdges,
    observedAt: input.observedAt
  })
  if (gate.status === 'blocked') return { gate }
  const plan = buildWorkflowChangeImpactPlan({ ...input, edges: gate.edges })
  return { gate, plan }
}

function normalizeFiles(files: readonly WorkflowSourceFileInput[]): WorkflowSourceFileInput[] {
  const seen = new Set<string>()
  return files.map((file) => {
    const path = normalizeRelativePath(file.path)
    if (!file.artifactId.trim()) throw new Error(`source artifactId must not be empty: ${path}`)
    if (seen.has(path)) throw new Error(`duplicate source path: ${path}`)
    seen.add(path)
    return { path, content: file.content, artifactId: file.artifactId.trim() }
  }).sort((left, right) => left.path.localeCompare(right.path))
}

function normalizeRelativePath(value: string): string {
  const raw = value.trim().replaceAll('\\', '/')
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) throw new Error(`source path must be relative: ${value}`)
  const normalized = posixPath.normalize(raw)
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error(`source path escapes project: ${value}`)
  return normalized
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (!normalized) throw new Error('projectId must not be empty')
  return normalized
}

function finiteObservedAt(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0
}

function pythonImportBase(fromPath: string, specifier: string): string {
  const match = /^(\.+)(.*)$/.exec(specifier)
  if (!match) return posixPath.normalize(posixPath.join(posixPath.dirname(fromPath), specifier.replaceAll('.', '/')))
  const levels = match[1].length
  const modulePath = match[2].replaceAll('.', '/')
  let directory = posixPath.dirname(fromPath)
  for (let index = 1; index < levels; index++) directory = posixPath.dirname(directory)
  return posixPath.normalize(posixPath.join(directory, modulePath))
}

function resolveLocalImport(
  fromPath: string,
  specifier: string,
  files: ReadonlyMap<string, WorkflowSourceFileInput>,
  language: ReturnType<typeof parseCodeFile> extends infer Parsed ? Parsed extends { language: infer L } ? L : never : never
): { kind: 'resolved'; path: string } | { kind: 'missing' } | { kind: 'ambiguous'; candidates: string[] } {
  const base = language === 'python'
    ? pythonImportBase(fromPath, specifier)
    : posixPath.normalize(posixPath.join(posixPath.dirname(fromPath), specifier))
  if (base === '.' || base.startsWith('../') || base.includes('/../')) return { kind: 'missing' }
  const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.json'].map((ext) => `${base}${ext}`), ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.json'].map((ext) => posixPath.join(base, `index${ext}`))]
  const matches = [...new Set(candidates.filter((candidate) => files.has(candidate)))]
  if (matches.length === 1) return { kind: 'resolved', path: matches[0] }
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches.sort() }
  return { kind: 'missing' }
}

// Keep the artifact type in this module's public surface for consumers that
// construct a source-backed graph alongside their existing Artifact records.
export type WorkflowSourceArtifact = Pick<WorkflowArtifactRecord, 'id' | 'uri' | 'projectId' | 'workItemId'>
