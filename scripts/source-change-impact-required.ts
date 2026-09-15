import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkflowAcceptanceRecord, WorkflowArtifactRecord } from '../src/shared/workflow-types'
import { buildWorkflowChangeImpactPlanFromSources, recallWorkflowSourceDependencies } from '../src/main/task/workflow-source-impact'

type Check = { id: string; status: 'passed' | 'failed'; detail: string }
const now = 1_758_000_000_000
const projectId = 'project-source-impact'
function artifact(id: string, path: string, workItemId: string): WorkflowArtifactRecord {
  return { schemaVersion: 1, id, projectId, goalId: 'goal-source-impact', workItemId, runId: `run:${workItemId}`, kind: 'code', title: path, uri: path, version: 1, digest: `${id}-digest`, provenance: 'explicit', metadata: { path }, createdAt: now, updatedAt: now }
}
function acceptance(id: string, workItemId: string): WorkflowAcceptanceRecord {
  return { schemaVersion: 1, id, projectId, goalId: 'goal-source-impact', workItemId, criteria: ['source impact'], status: 'passed', evidenceRefs: [], verifier: 'contract', verifiedAt: now, revision: 1, createdAt: now, updatedAt: now }
}
function check(checks: Check[], id: string, detail: string, fn: () => void): void {
  try { fn(); checks.push({ id, status: 'passed', detail }) } catch (error) { checks.push({ id, status: 'failed', detail: error instanceof Error ? error.message : String(error) }) }
}
function main(): void {
  const files = [
    { path: 'src/source.ts', artifactId: 'a:source', content: 'export const source = 1\n' },
    { path: 'src/consumer.ts', artifactId: 'a:consumer', content: "import { source } from './source'\nexport const consumer = source\n" },
    { path: 'src/entry.ts', artifactId: 'a:entry', content: "import { consumer } from './consumer'\nexport const entry = consumer\n" }
  ]
  const artifacts = [artifact('a:source', 'src/source.ts', 'wi:source'), artifact('a:consumer', 'src/consumer.ts', 'wi:consumer'), artifact('a:entry', 'src/entry.ts', 'wi:entry')]
  const acceptances = [acceptance('accept:consumer', 'wi:consumer'), acceptance('accept:entry', 'wi:entry')]
  const checks: Check[] = []
  check(checks, 'import-edge-direction', '轻量 import 解析生成 imported target -> importer 的 depends_on 边', () => {
    const recall = recallWorkflowSourceDependencies({ projectId, files, observedAt: now })
    if (recall.status !== 'ready') throw new Error(`unexpected gate ${recall.status}`)
    const pair = recall.edges.map((edge) => `${edge.fromArtifactId}->${edge.toArtifactId}`).join(',')
    if (pair !== 'a:source->a:consumer,a:consumer->a:entry') throw new Error(`unexpected edges ${pair}`)
  })
  check(checks, 'transitive-source-recall', '源文件变更沿解析出的依赖闭包召回下游 WorkItem 和 Acceptance', () => {
    const result = buildWorkflowChangeImpactPlanFromSources({ projectId, sourceFiles: files, artifacts, acceptances, changedArtifactIds: ['a:source'], observedAt: now })
    if (!result.plan) throw new Error(`source gate blocked: ${result.gate.unresolvedReferences.join(',')}`)
    if (result.plan.rerunWorkItemIds.join(',') !== 'wi:consumer,wi:entry,wi:source') throw new Error(`unexpected rerun ${result.plan.rerunWorkItemIds}`)
    if (result.plan.acceptanceRechecks.map((item) => item.acceptanceId).join(',') !== 'accept:consumer,accept:entry') throw new Error('downstream Acceptance was not rechecked')
  })
  check(checks, 'missing-import-fail-closed', '缺失相对 import 进入 blocked gate，不生成可执行影响计划', () => {
    const result = buildWorkflowChangeImpactPlanFromSources({ projectId, sourceFiles: [{ ...files[1], content: "import './missing'\n" }, files[0]], artifacts: artifacts.slice(0, 2), acceptances: [], changedArtifactIds: ['a:source'] })
    if (result.gate.status !== 'blocked' || result.plan) throw new Error('missing import did not fail closed')
    if (!result.gate.unresolvedReferences.some((item) => item.includes('missing-import'))) throw new Error('missing import was not recorded')
  })
  check(checks, 'syntax-error-fail-closed', '语法解析异常的 source snapshot 不参与自动影响召回', () => {
    const result = recallWorkflowSourceDependencies({ projectId, files: [{ path: 'src/broken.ts', artifactId: 'a:broken', content: 'export const broken = {' }] })
    if (result.status !== 'blocked' || !result.unresolvedReferences.some((item) => item === 'parse-error:src/broken.ts')) throw new Error('syntax error did not fail closed')
  })
  check(checks, 'ambiguous-import-fail-closed', '多个候选文件的 import 不猜测，进入 blocked gate', () => {
    const result = recallWorkflowSourceDependencies({ projectId, files: [
      { path: 'src/a.ts', artifactId: 'a:a', content: "import './util'" },
      { path: 'src/util.ts', artifactId: 'a:u1', content: '' },
      { path: 'src/util/index.ts', artifactId: 'a:u2', content: '' }
    ] })
    if (result.status !== 'blocked' || result.ambiguousReferences.length !== 1) throw new Error('ambiguous import was not blocked')
  })
  check(checks, 'explicit-graph-precedence', '已有显式 Artifact Graph 时不叠加未经审查的 parser 边', () => {
    const explicit = [{ schemaVersion: 1 as const, id: 'edge:explicit', fromArtifactId: 'a:source', toArtifactId: 'a:consumer', relation: 'depends_on' as const, projectId, createdAt: now, updatedAt: now }]
    const result = recallWorkflowSourceDependencies({ projectId, files: [{ ...files[1], content: "import './missing'" }, files[0]], explicitEdges: explicit })
    if (result.status !== 'ready' || result.edges.length !== 1 || result.edges[0].id !== 'edge:explicit') throw new Error('explicit graph did not take precedence')
  })
  check(checks, 'source-digest-stability', '输入文件顺序变化不改变源快照摘要', () => {
    const one = recallWorkflowSourceDependencies({ projectId, files })
    const two = recallWorkflowSourceDependencies({ projectId, files: [...files].reverse() })
    if (one.sourceDigest !== two.sourceDigest) throw new Error('source digest changed with input order')
  })
  const failed = checks.filter((item) => item.status === 'failed')
  const report = { schemaVersion: 1, contract: 'V2-011 source dependency recall / fail-closed gate', generatedAt: new Date().toISOString(), status: failed.length ? 'failed' : 'passed', checks, summary: `${checks.length - failed.length}/${checks.length} checks passed`, limitations: ['parser only resolves relative imports in supplied source snapshots', 'explicit Artifact Graph remains authoritative', 'no production or real-user recall claim'] }
  const reportDir = join(process.cwd(), 'test-results', 'source-change-impact')
  mkdirSync(reportDir, { recursive: true }); writeFileSync(join(reportDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  if (failed.length) process.exitCode = 1
}
main()
