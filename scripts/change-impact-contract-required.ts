import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  WorkflowAcceptanceRecord,
  WorkflowArtifactEdgeRecord,
  WorkflowArtifactRecord,
  WorkflowEvidenceLinkRecord
} from '../src/shared/workflow-types'
import {
  applyWorkflowAcceptanceRechecks,
  buildWorkflowChangeImpactPlan,
  WorkflowChangeImpactError
} from '../src/main/task/workflow-change-impact'

type Check = { id: string; status: 'passed' | 'failed'; detail: string }

const outputDir = join(process.cwd(), 'test-results', 'change-impact-contract')
const reportPath = join(outputDir, 'latest.json')
const now = 1_758_000_000_000

function artifact(
  id: string,
  workItemId: string,
  metadata: Record<string, unknown> = {},
  projectId = 'project-change-impact'
): WorkflowArtifactRecord {
  return {
    schemaVersion: 1,
    id,
    projectId,
    goalId: 'goal-change-impact',
    workItemId,
    runId: `run:${workItemId}`,
    kind: 'document',
    title: id,
    version: 1,
    digest: `${id}-digest`,
    provenance: 'explicit',
    metadata,
    createdAt: now,
    updatedAt: now
  }
}

function edge(
  id: string,
  fromArtifactId: string,
  toArtifactId: string,
  relation: WorkflowArtifactEdgeRecord['relation']
): WorkflowArtifactEdgeRecord {
  return {
    schemaVersion: 1,
    id,
    fromArtifactId,
    toArtifactId,
    relation,
    projectId: 'project-change-impact',
    goalId: 'goal-change-impact',
    createdAt: now,
    updatedAt: now
  }
}

function acceptance(id: string, workItemId: string, status: WorkflowAcceptanceRecord['status']): WorkflowAcceptanceRecord {
  return {
    schemaVersion: 1,
    id,
    projectId: 'project-change-impact',
    goalId: 'goal-change-impact',
    workItemId,
    criteria: ['交付物满足确认条件'],
    status,
    evidenceRefs: [`evidence:${id}`],
    ...(status === 'passed' ? { verifier: 'contract', verifiedAt: now, notes: 'previously verified' } : {}),
    revision: 4,
    createdAt: now,
    updatedAt: now
  }
}

function link(id: string, artifactId: string, acceptanceId: string): WorkflowEvidenceLinkRecord {
  return {
    schemaVersion: 1,
    id,
    evidenceId: `evidence:${acceptanceId}`,
    projectId: 'project-change-impact',
    artifactId,
    acceptanceId,
    evidenceOrigin: 'workflow',
    relation: 'verifies',
    createdAt: now
  }
}

function assert(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail)
}

function expectImpactError(operation: () => unknown, code: WorkflowChangeImpactError['code']): void {
  try {
    operation()
  } catch (error) {
    assert(error instanceof WorkflowChangeImpactError, `expected WorkflowChangeImpactError, got ${String(error)}`)
    assert(error.code === code, `expected ${code}, got ${error.code}`)
    return
  }
  throw new Error(`expected impact error ${code}`)
}

function check(checks: Check[], id: string, detail: string, operation: () => void): void {
  try {
    operation()
    checks.push({ id, status: 'passed', detail })
  } catch (error) {
    checks.push({ id, status: 'failed', detail: error instanceof Error ? error.message : String(error) })
  }
}

function main(): void {
  const checks: Check[] = []
  const artifacts = [
    artifact('fact:audience', 'wi:research'),
    artifact('copy:brief', 'wi:copy'),
    artifact('code:landing', 'wi:code'),
    artifact('delivery:report', 'wi:delivery'),
    artifact('manual:brand', 'wi:brand', { manuallyModified: true }),
    artifact('unrelated', 'wi:unrelated')
  ]
  const edges = [
    edge('edge:fact-copy', 'fact:audience', 'copy:brief', 'derived_from'),
    edge('edge:copy-code', 'copy:brief', 'code:landing', 'produced_from'),
    edge('edge:code-delivery', 'code:landing', 'delivery:report', 'supports'),
    edge('edge:fact-brand', 'fact:audience', 'manual:brand', 'references'),
    edge('edge:unrelated', 'unrelated', 'manual:brand', 'related_to')
  ]
  const acceptances = [
    acceptance('accept:copy', 'wi:copy', 'passed'),
    acceptance('accept:code', 'wi:code', 'waived'),
    acceptance('accept:brand', 'wi:brand', 'passed'),
    acceptance('accept:unrelated', 'wi:unrelated', 'passed')
  ]
  const evidenceLinks = [
    link('link:copy', 'copy:brief', 'accept:copy'),
    link('link:brand', 'manual:brand', 'accept:brand')
  ]
  const input = {
    projectId: 'project-change-impact',
    changedArtifactIds: ['fact:audience'],
    artifacts,
    edges,
    acceptances,
    evidenceLinks,
    protectedArtifactIds: ['manual:brand'],
    manuallyModifiedArtifactIds: ['manual:brand']
  }
  const plan = buildWorkflowChangeImpactPlan(input)

  check(checks, 'transitive-artifact-closure', '业务事实变更沿有因果关系的 Artifact Graph 传递到下游成果', () => {
    assert(plan.impactedArtifactIds.join(',') === 'code:landing,copy:brief,delivery:report,fact:audience', `unexpected closure ${plan.impactedArtifactIds.join(',')}`)
    assert(plan.changedArtifactIds.join(',') === 'fact:audience', 'changed source identity drifted')
  })

  check(checks, 'work-item-rerun-scope', '只生成受影响 WorkItem 的局部重跑集合，并保持稳定去重排序', () => {
    assert(plan.rerunWorkItemIds.join(',') === 'wi:code,wi:copy,wi:delivery,wi:research', `unexpected rerun set ${plan.rerunWorkItemIds.join(',')}`)
    assert(!plan.rerunWorkItemIds.includes('wi:unrelated'), 'unrelated WorkItem was scheduled')
    assert(!plan.rerunWorkItemIds.includes('wi:brand'), 'protected WorkItem was scheduled')
  })

  check(checks, 'protected-manual-modification', '人工修改成果进入 protected/review 保护集合，不被自动重跑覆盖', () => {
    assert(plan.protectedArtifactIds.includes('manual:brand'), 'manual artifact was not protected')
    assert(!plan.impactedArtifactIds.includes('manual:brand'), 'manual artifact entered automatic rerun set')
    assert(plan.acceptanceRechecks.find((item) => item.acceptanceId === 'accept:brand')?.reason === 'protected_artifact', 'protected Acceptance reason missing')
  })

  check(checks, 'acceptance-recheck-plan', '受影响 Acceptance 自动生成 pending 重验计划并递增 revision', () => {
    const copy = plan.acceptanceRechecks.find((item) => item.acceptanceId === 'accept:copy')
    const code = plan.acceptanceRechecks.find((item) => item.acceptanceId === 'accept:code')
    assert(copy?.previousStatus === 'passed' && copy.nextStatus === 'pending' && copy.nextRevision === 5, 'passed Acceptance recheck is incomplete')
    assert(code?.previousStatus === 'waived' && code.reason === 'downstream_artifact', 'waived downstream Acceptance was not invalidated')
    assert(!plan.acceptanceRechecks.some((item) => item.acceptanceId === 'accept:unrelated'), 'unrelated Acceptance was invalidated')
  })

  check(checks, 'apply-recheck-transition', '应用计划会清除旧验证/豁免字段并保留可审计的变更摘要', () => {
    const applied = applyWorkflowAcceptanceRechecks(acceptances, plan, now + 1_000)
    const copy = applied.find((item) => item.id === 'accept:copy')!
    assert(copy.status === 'pending' && copy.revision === 5, 'Acceptance transition did not apply')
    assert(copy.verifiedAt === undefined && copy.verifier === undefined, 'old verification metadata survived')
    assert(copy.evidenceRefs.length === 0 && copy.criterionEvidence === undefined, 'old evidence selection survived')
    assert(copy.notes?.includes(plan.planDigest) === true, 'impact digest was not retained in notes')
  })

  check(checks, 'mixed-acceptance-statuses', '每种验收状态均递增版本；已有失败保持可见，验证中撤销为 pending', () => {
    const statuses = ['pending', 'verifying', 'passed', 'failed', 'waived'] as const
    const mixed = statuses.map((status) => ({ ...acceptance(`mixed:${status}`, 'wi:copy', status),
      verifier: 'stale-verifier', verifiedAt: now, waiverReason: 'stale-waiver', waivedBy: 'stale-actor',
      criterionEvidence: [{ criterionId: 'criterion:0', criterionIndex: 0, evidenceRefs: ['old-evidence'] }] }))
    const mixedPlan = buildWorkflowChangeImpactPlan({ ...input, acceptances: mixed, evidenceLinks: [] })
    const reset = applyWorkflowAcceptanceRechecks(mixed, mixedPlan, now + 1_000)
    assert(reset.length === 5, 'mixed Acceptance coverage missing')
    for (const [index, item] of reset.entries()) {
      assert(item.status === (statuses[index] === 'failed' ? 'failed' : 'pending'), `invalid reset status for ${statuses[index]}`)
      assert(item.revision === mixed[index].revision + 1, 'old revision was not fenced')
      assert(item.verifier === undefined && item.verifiedAt === undefined && item.waiverReason === undefined && item.waivedBy === undefined, 'stale authority survived')
      assert(item.evidenceRefs.length === 0 && item.criterionEvidence === undefined, 'stale coverage survived')
    }
  })

  for (const protection of ['protectedArtifactIds', 'manuallyModifiedArtifactIds'] as const) {
    check(checks, `protected-sibling-${protection}`, '同 WorkItem 的受保护成果即使不在变更子图中，也阻止整任务自动重跑', () => {
      const mixed = buildWorkflowChangeImpactPlan({ ...input,
        artifacts: [...artifacts, artifact('sibling:untouched-manual', 'wi:copy')],
        [protection]: [...input[protection], 'sibling:untouched-manual']
      })
      assert(!mixed.rerunWorkItemIds.includes('wi:copy'), 'mixed-output WorkItem remained automatically runnable')
      assert(mixed.reviewWorkItemIds.includes('wi:copy'), 'mixed-output WorkItem has no review disposition')
      assert(mixed.artifacts.find((item) => item.artifactId === 'copy:brief')?.reason === 'protected_work_item', 'review has no protection explanation')
      assert(!mixed.impactedArtifactIds.includes('copy:brief'), 'affected sibling remained in automatic artifact set')
      assert(!mixed.artifacts.some((item) => item.artifactId === 'sibling:untouched-manual'), 'untouched sibling was incorrectly traversed')
    })
  }

  check(checks, 'ambiguous-relation-review', '无法可靠判断的关系只进入待核验集合，并在报告中留下未决引用', () => {
    const ambiguous = buildWorkflowChangeImpactPlan({ ...input, edges: [...edges, edge('edge:fact-custom', 'fact:audience', 'unrelated', 'custom')] })
    assert(ambiguous.reviewArtifactIds.includes('unrelated'), 'ambiguous target was not marked for review')
    assert(ambiguous.unresolvedReferences.includes('ambiguous-edge:edge:fact-custom'), 'ambiguous edge was not recorded')
    assert(!ambiguous.rerunWorkItemIds.includes('wi:unrelated'), 'ambiguous target was auto scheduled')
  })

  check(checks, 'deterministic-plan-digest', '输入顺序变化不改变影响结果或计划摘要', () => {
    const shuffled = buildWorkflowChangeImpactPlan({
      ...input,
      artifacts: [...artifacts].reverse(),
      edges: [...edges].reverse(),
      acceptances: [...acceptances].reverse(),
      evidenceLinks: [...evidenceLinks].reverse()
    })
    assert(shuffled.planDigest === plan.planDigest, 'plan digest changed with input order')
  })

  check(checks, 'revision-fencing', 'Acceptance 在计划生成后发生变化时拒绝过期重验写入', () => {
    const changed = acceptances.map((item) => item.id === 'accept:copy' ? { ...item, revision: item.revision + 1 } : item)
    expectImpactError(() => applyWorkflowAcceptanceRechecks(changed, plan, now + 1_000), 'invalid_acceptance_revision')
    const statusChanged = acceptances.map((item) => item.id === 'accept:copy' ? { ...item, status: 'verifying' as const } : item)
    expectImpactError(() => applyWorkflowAcceptanceRechecks(statusChanged, plan, now + 1_000), 'invalid_acceptance_revision')
  })

  check(checks, 'cross-project-fail-closed', '跨项目变更引用不会被误判为可重跑', () => {
    expectImpactError(() => buildWorkflowChangeImpactPlan({ ...input, edges: [...edges, { ...edge('edge:cross', 'fact:audience', 'code:landing', 'derived_from'), projectId: 'other-project' }] }), 'cross_project_reference')
  })

  check(checks, 'missing-change-source', '缺失变更源会 fail-closed，而不是返回空影响集', () => {
    expectImpactError(() => buildWorkflowChangeImpactPlan({ ...input, changedArtifactIds: ['missing'] }), 'missing_artifact')
  })

  const failed = checks.filter((item) => item.status === 'failed')
  const report = {
    schemaVersion: 1,
    contract: 'V2-011 workflow change impact / local rerun / acceptance recheck',
    generatedAt: new Date().toISOString(),
    status: failed.length === 0 ? 'passed' : 'failed',
    source: {
      changedArtifactIds: plan.changedArtifactIds,
      impactedArtifactIds: plan.impactedArtifactIds,
      reviewArtifactIds: plan.reviewArtifactIds,
      protectedArtifactIds: plan.protectedArtifactIds,
      rerunWorkItemIds: plan.rerunWorkItemIds,
      acceptanceRechecks: plan.acceptanceRechecks,
      unresolvedReferences: plan.unresolvedReferences,
      planDigest: plan.planDigest
    },
    checks,
    summary: `${checks.filter((item) => item.status === 'passed').length}/${checks.length} checks passed`,
    limitations: [
      'planner and transition are pure; the main-process commit facade persists the plan and Acceptance revisions atomically (covered by the companion Electron transaction contract)',
      'does not claim automatic source parsing or real-user change-impact recall'
    ]
  }
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
  if (failed.length) process.exitCode = 1
}

main()
