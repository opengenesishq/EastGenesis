import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import process from 'node:process'
import { openProjectWorkspaceCommandService } from '../src/main/project-workspace/command-service'
import { openProjectWorkspaceStore } from '../src/main/project-workspace/store'
import { createCanonicalSupervisorRun } from '../src/main/task/supervisor-taskrun-bridge'
import { SupervisorStateStore } from '../src/main/task/supervisor-state'
import { buildTaskSnapshot, saveTaskSnapshot } from '../src/main/task/task-snapshot'
import { prepareTaskSnapshotRecovery } from '../src/main/task/task-snapshot-recovery-lifecycle'
import { transitionTaskRun } from '../src/main/task/task-run'
import { bindFrozenRunRoutingPolicy } from '../src/main/task/frozen-routing-binding'
import { sealFrozenRoutingPolicy } from '../src/main/task/frozen-routing-policy'
import { compileMission, missionCompilationToTaskPlanDraft } from '../src/main/task/mission-compiler'
import { evaluateContextUsage, planCompressionBoundary, type ContextMessage } from '../src/main/agent/context-compressor'
import {
  createWorkflowArtifact,
  createWorkflowArtifactLocation,
  createWorkflowArtifactAcceptance,
  createWorkflowEvidence,
  createWorkflowEvidenceLink,
  saveWorkflowAcceptance
} from '../src/main/task/workflow-ledger-api'
import type { SessionMeta, TaskRunRecord } from '../src/shared/types'

const projectId = 'fixture-product-launch-v2'
const rootDir = mkdtempSync(join(tmpdir(), 'caogen-product-launch-'))
const outputDir = join(process.cwd(), 'test-results', 'product-launch-fixture-runtime')
const reportPath = join(outputDir, 'latest.json')
const proofPackPath = join(outputDir, 'proof-pack.json')
const now = Date.now()

runFixture().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

async function runFixture(): Promise<void> {
try {
  const mission = compileMission({
    projectId,
    goalId: 'fixture-goal-product-launch-v2',
    objective: '在本周内形成一个可运行、可说明、可验收的产品发布包。',
    constraints: [
      '使用脱敏输入和本地 fixture',
      '未经用户批准不得执行外部发布或不可逆动作',
      '每个成果必须关联 Evidence 和 Acceptance'
    ],
    deliverables: ['运行页面', '使用说明', '测试证据', 'Proof Pack'],
    materials: [{ id: 'fixture-manifest', title: 'Product Launch Fixture manifest' }],
    businessLineId: 'studio',
    businessLineName: '产品发布府',
    now
  })
  assert(mission.workItems.length === 4 && mission.acceptances.length === 4, 'Mission Compiler must produce the four-role launch blueprint')
  const missionPlanDraft = missionCompilationToTaskPlanDraft(mission)
  assert(missionPlanDraft.source === 'genesis' && missionPlanDraft.dataEgress?.length === 0, 'Mission TaskPlan draft must remain pending and offline')
  assert(missionPlanDraft.steps.length === mission.workItems.length, 'Mission TaskPlan draft must preserve WorkItem steps')
  const workspace = await openProjectWorkspaceStore(rootDir)
  await workspace.createWorkspace({
    id: projectId,
    name: '产品发布府',
    kind: 'opc',
    createdAt: now,
    updatedAt: now
  })

  const commands = await openProjectWorkspaceCommandService(rootDir)
  const goal = await commands.createGoal({
    id: 'fixture-goal-product-launch-v2',
    projectId,
    title: '本周上线一个产品',
    objective: mission.goal.objective,
    constraints: mission.acceptances[0].criteria.slice(1),
    successCriteria: ['运行页面可启动', '使用说明可定位', '验证证据可复查'],
    forbiddenActions: ['未经批准执行外部发布或不可逆动作'],
    riskLevel: 'high',
    status: 'planned',
    createdBy: 'product-launch-fixture',
    acceptance: [{ id: 'fixture-goal-acceptance', criterion: '交付包包含成果和验证证据', required: true }]
  })

  const definitions = [
    ['research', 'research', '整理产品说明'],
    ['build', 'coding', '实现最小运行页面'],
    ['verify', 'testing', '执行独立验证'],
    ['proof', 'delivery', '生成 Proof Pack']
  ] as const
  const workItems = []
  for (const [key, type, title] of definitions) {
    workItems.push(await commands.createWorkItem({
      id: `fixture-work-${key}-v2`,
      projectId,
      goalId: goal.id,
      businessLineId: 'studio',
      type,
      title,
      description: `产品发布府 fixture：${title}`,
      status: key === 'research' ? 'ready' : 'backlog',
      owner: { type: 'digital_worker', id: `fixture-worker-${key}`, displayName: `Fixture ${key}` },
      acceptanceSpec: [{ id: `fixture-${key}-acceptance`, criterion: `${title} 有可复查结果`, required: true }]
    }))
  }

  const taskRun: TaskRunRecord = {
    schemaVersion: 1,
    id: 'fixture-run-research-v2',
    sessionId: 'fixture-session-research-v2',
    taskId: 'fixture-task-research-v2',
    status: 'queued',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    digitalWorkerBinding: { kind: 'unscoped' },
    createdAt: now,
    updatedAt: now
  }
  const meta: SessionMeta = {
    id: taskRun.sessionId,
    title: '整理产品说明',
    cwd: rootDir,
    childTaskId: taskRun.taskId,
    workspaceId: projectId,
    goalId: goal.id,
    workItemId: workItems[0].id,
    businessLineId: 'studio',
    model: 'fixture-model',
    providerId: 'fixture-provider',
    taskStrategy: 'plan',
    permissionMode: 'plan',
    digitalWorkerBinding: { kind: 'unscoped' },
    status: 'starting',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: now
  }
  await saveTaskSnapshot(buildTaskSnapshot({
    meta,
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run: taskRun,
    now
  }), rootDir)

  const supervisor = new SupervisorStateStore(rootDir)
  const run = await createCanonicalSupervisorRun(supervisor, rootDir, {
    id: 'fixture-run-research-v2',
    projectId,
    goalId: goal.id,
    workItemId: workItems[0].id,
    maxRetries: 1
  }, { actorId: 'product-launch-fixture' })
  const persistedItem = await workspace.getWorkItem(workItems[0].id)
  const persistedRun = await supervisor.getRun(run.id)
  assert(persistedItem?.runRefs.includes(run.id), 'Run must be bound to its canonical WorkItem')
  assert(persistedRun?.goalId === goal.id && persistedRun.workItemId === workItems[0].id, 'Run ownership must match Goal and WorkItem')

  const parallelRuns = [run]
  for (let index = 1; index < workItems.length; index += 1) {
    const item = workItems[index]
    const key = definitions[index][0]
    const roleRun: TaskRunRecord = {
      schemaVersion: 1,
      id: `fixture-run-${key}-v2`,
      sessionId: `fixture-session-${key}-v2`,
      taskId: `fixture-task-${key}-v2`,
      status: 'queued',
      revision: 1,
      attempt: 1,
      recoveryCount: 0,
      digitalWorkerBinding: { kind: 'unscoped' },
      createdAt: now,
      updatedAt: now
    }
    const roleMeta: SessionMeta = {
      ...meta,
      id: roleRun.sessionId,
      title: item.title,
      childTaskId: roleRun.taskId,
      workItemId: item.id,
      digitalWorkerBinding: { kind: 'unscoped' }
    }
    await saveTaskSnapshot(buildTaskSnapshot({
      meta: roleMeta,
      transcript: [],
      lastSeq: 0,
      eventCount: 0,
      reason: 'created',
      run: roleRun,
      now
    }), rootDir)
    parallelRuns.push(await createCanonicalSupervisorRun(supervisor, rootDir, {
      id: roleRun.id,
      projectId,
      goalId: goal.id,
      workItemId: item.id,
      maxRetries: 1
    }, { actorId: 'product-launch-fixture' }))
  }
  assert(parallelRuns.length === workItems.length, 'Each launch role must own an independent Run')
  const routedRun = parallelRuns[1]
  const routedSessionId = 'fixture-session-build-v2'
  const routedTaskId = 'fixture-task-build-v2'
  const routeDigest = '1'.repeat(64)
  const routeTargetRef = { providerId: 'fixture-provider', model: 'fixture-model' }
  const routeTarget = { ...routeTargetRef, protocol: 'openai.responses' as const }
  const routePolicy = sealFrozenRoutingPolicy({
    schemaVersion: 1,
    evaluatorVersion: 1,
    executionDomain: 'native_text',
    owner: {
      runId: routedRun.id,
      sessionId: routedSessionId,
      taskId: routedTaskId,
      projectId,
      goalId: goal.id,
      workItemId: workItems[1].id,
      businessLineId: workItems[1].businessLineId
    },
    messageId: 'fixture-message-build-v2',
    frozenAt: Date.now(),
    originalPromptDigest: routeDigest,
    ruleSetRevision: 1,
    ruleSetDigest: routeDigest,
    matchedRules: [],
    contextDigest: routeDigest,
    catalogDigest: routeDigest,
    evaluationDigest: routeDigest,
    baseStrategy: 'balanced',
    baseStrategySource: { kind: 'global' },
    userIntent: { kind: 'global' },
    effectivePolicy: { selection: { kind: 'global_auto' }, strategy: 'balanced', failure: { kind: 'pause' } },
    initialTarget: routeTarget,
    qualifiedTargets: [{ ...routeTarget, connectionIdentity: { generationId: '00000000-0000-4000-8000-000000000002', revision: 1 } }],
    retryTargets: [],
    hardBounds: { requiredCapabilities: [], minContextTokens: 1, allowedProviderIds: ['fixture-provider'], locality: 'local_only' }
  })
  const boundRun = await bindFrozenRunRoutingPolicy({
    runId: routedRun.id,
    sessionId: routedSessionId,
    expectedRunRevision: routedRun.revision,
    policy: routePolicy
  }, rootDir)
  assert(boundRun.routingPolicy?.policyDigest === routePolicy.policyDigest, 'Run must persist an immutable routing receipt')
  const readbackScript = join(process.cwd(), 'scripts', 'product-launch-fixture-route-readback.ts')
  const readbackOutput = execFileSync(join(process.cwd(), 'node_modules', '.bin', 'tsx'), [
    readbackScript, rootDir, routedSessionId, routedRun.id, routePolicy.policyDigest
  ], { cwd: process.cwd(), encoding: 'utf8' }).trim()
  const readback = JSON.parse(readbackOutput) as { status?: string; policyDigest?: string; runId?: string }
  assert(readback.status === 'passed' && readback.policyDigest === routePolicy.policyDigest && readback.runId === routedRun.id,
    'Independent process must read back the exact Route Receipt')
  const contextMessages: ContextMessage[] = Array.from({ length: 16 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `fixture context message ${index} `.repeat(120)
  }))
  const contextUsage = evaluateContextUsage({ usedTokens: 9_200, model: 'fixture-model', contextWindowTokens: 10_000 })
  const contextBoundary = planCompressionBoundary(contextMessages, 4)
  assert(contextUsage.shouldCompress && contextUsage.pressure === 'critical', 'Context Pack must enter compression pressure at the configured threshold')
  assert(contextBoundary.canCompress && contextBoundary.keepFrom > 1 && contextBoundary.recentCount === 4,
    'Context Pack compression must preserve a user boundary and the configured recent window')
  await Promise.all(workItems.map(async (item) => {
    if (item.status === 'backlog') await commands.transitionWorkItem(item.id, 'ready')
    const ready = await workspace.getWorkItem(item.id)
    const ownerId = ready?.owner?.id
    assert(ownerId, `WorkItem ${item.id} must retain its role owner`)
    await commands.acquireWorkItemLease(item.id, { ownerId })
    await commands.transitionWorkItem(item.id, 'running')
  }))
  const runningItems = await Promise.all(workItems.map((item) => workspace.getWorkItem(item.id)))
  assert(runningItems.every((item) => item?.status === 'running'), 'Four launch roles must report running in parallel')
  assert(runningItems.every((item, index) => item?.runRefs.includes(parallelRuns[index].id)), 'Each running role must expose its canonical Run reference')

  const failureAt = Date.now() + 10
  const failedRun = transitionTaskRun(
    transitionTaskRun({ ...run, digitalWorkerBinding: { kind: 'unscoped' } }, 'executing', { now: failureAt - 1 }),
    'failed',
    { now: failureAt, error: 'fixture-local-failure' }
  )
  const failedCandidate = buildTaskSnapshot({
    meta,
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'important-event',
    run: failedRun,
    now: failureAt
  })
  await saveTaskSnapshot(failedCandidate, rootDir)
  assert(failedCandidate.run?.status === 'failed', 'Failed local Run must remain recoverable')
  const recovered = await prepareTaskSnapshotRecovery(failedCandidate, rootDir, () => false)
  assert(recovered.recoveredRun.status === 'recovering', 'Local failure must transition through recovering')
  assert(recovered.recoveredRun.recoveryCount === (failedRun.recoveryCount ?? 0) + 1, 'Recovery must increment recoveryCount once')

  const artifactBytes = Buffer.from('# Product Launch Fixture\n\n可运行、可说明、可验收。\n', 'utf8')
  const artifactPath = join(outputDir, 'product-brief.md')
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(artifactPath, artifactBytes)
  const artifactDigest = createHash('sha256').update(artifactBytes).digest('hex')
  const artifact = await createWorkflowArtifact({
    id: 'fixture-artifact-product-brief-v2',
    projectId,
    goalId: goal.id,
    workItemId: workItems[0].id,
    runId: run.id,
    kind: 'document',
    title: '产品发布说明',
    uri: 'fixture://product-launch/product-brief.md',
    version: 1,
    digest: artifactDigest,
    mediaType: 'text/markdown',
    provenance: 'explicit',
    createdAt: now,
    updatedAt: now
  }, rootDir)
  const artifactLocation = await createWorkflowArtifactLocation({
    id: 'fixture-location-product-brief-v2',
    artifactId: artifact.id,
    projectId,
    goalId: goal.id,
    workItemId: workItems[0].id,
    runId: run.id,
    kind: 'file',
    path: artifactPath,
    availability: 'available',
    checksum: artifactDigest,
    sizeBytes: artifactBytes.length,
    mediaType: 'text/markdown',
    createdAt: now,
    updatedAt: now
  }, rootDir)
  const artifactAcceptance = await createWorkflowArtifactAcceptance({ artifactId: artifact.id }, rootDir)
  const evidence = await createWorkflowEvidence({
    evidenceId: 'fixture-evidence-product-brief-v2',
    projectId,
    goalId: goal.id,
    workItemId: workItems[0].id,
    runId: run.id,
    artifactId: artifact.id,
    kind: 'delivery_check',
    title: '产品发布说明 fixture 校验',
    summary: 'Fixture 仅验证成果登记和证据绑定，不代表真实 Provider 交付。',
    contentDigest: artifactDigest
  }, rootDir, { source: 'runtime', verifier: 'product-launch-fixture', observedAt: now })
  const criterion = artifactAcceptance.acceptance.criterionPolicies?.[0]
  assert(criterion, 'Artifact Acceptance must expose a criterion policy')
  const verifyingAcceptance = await saveWorkflowAcceptance({
    ...artifactAcceptance.acceptance,
    status: 'verifying',
    revision: artifactAcceptance.acceptance.revision + 1,
    updatedAt: now
  }, rootDir, { caller: 'user', actorId: 'product-launch-fixture' })
  await createWorkflowEvidenceLink({
    id: 'fixture-acceptance-link-product-brief-v2',
    evidenceId: evidence.evidenceId,
    projectId,
    runId: run.id,
    artifactId: artifact.id,
    acceptanceId: verifyingAcceptance.id,
    criterionId: criterion.criterionId,
    evidenceOrigin: 'workflow',
    relation: 'verifies',
    createdAt: now
  }, rootDir)
  const passedAcceptance = await saveWorkflowAcceptance({
    ...verifyingAcceptance,
    status: 'passed',
    evidenceRefs: [evidence.evidenceId],
    criterionEvidence: [{ criterionId: criterion.criterionId, criterionIndex: criterion.criterionIndex, evidenceRefs: [evidence.evidenceId] }],
    verifier: 'product-launch-fixture',
    verifiedAt: now,
    revision: verifyingAcceptance.revision + 1,
    updatedAt: now
  }, rootDir, { caller: 'user', actorId: 'product-launch-fixture' })

  const proofPack = {
    schemaVersion: 1,
    kind: 'caogen.proof-pack',
    packId: 'fixture-product-launch-proof-pack-v2',
    projectId,
    goalId: goal.id,
    missionDigest: mission.digest,
    missionPlanDraft: { source: missionPlanDraft.source, stepCount: missionPlanDraft.steps.length, acceptanceCount: missionPlanDraft.acceptanceCriteria.length, dataEgress: missionPlanDraft.dataEgress },
    runId: run.id,
    workItems: runningItems.map((item, index) => ({
      id: item?.id,
      status: item?.status,
      runId: parallelRuns[index].id,
      ownerId: item?.owner?.id
    })),
    routeReceipt: {
      runId: boundRun.id,
      policyDigest: boundRun.routingPolicy?.policyDigest,
      initialTarget: routePolicy.initialTarget,
      frozenAt: routePolicy.frozenAt,
      independentReadback: readback.status
    },
    contextPack: {
      usageRatio: contextUsage.usageRatio,
      pressure: contextUsage.pressure,
      keepFrom: contextBoundary.keepFrom,
      olderCount: contextBoundary.olderCount,
      recentCount: contextBoundary.recentCount,
      compressionBoundary: 'user-message'
    },
    artifacts: [{
      id: artifact.id,
      title: artifact.title,
      version: artifact.version,
      source: artifact.provenance,
      uri: artifact.uri,
      location: artifactPath,
      digest: artifact.digest,
      mediaType: artifact.mediaType
    }],
    requirements: goal.successCriteria,
    evidence: [{
      id: evidence.evidenceId,
      kind: evidence.kind,
      artifactId: artifact.id,
      digest: evidence.contentDigest,
      verifier: 'product-launch-fixture'
    }],
    acceptance: {
      id: passedAcceptance.id,
      status: passedAcceptance.status,
      evidenceRefs: passedAcceptance.evidenceRefs,
      verifier: passedAcceptance.verifier,
      verifiedAt: passedAcceptance.verifiedAt
    },
    recovery: {
      failedStatus: failedRun.status,
      recoveredStatus: recovered.recoveredRun.status,
      recoveryCount: recovered.recoveredRun.recoveryCount
    },
    validation: {
      baselineReport: 'test-results/baseline/latest.json',
      requiredFixtureReport: 'test-results/product-launch-fixture/latest.json'
    }
  }
  const result = {
    schemaVersion: 1,
    kind: 'caogen.product-launch-fixture-runtime-report',
    status: 'passed',
    projectId,
    goalId: goal.id,
    missionDigest: mission.digest,
    missionPlanDraft: { source: missionPlanDraft.source, stepCount: missionPlanDraft.steps.length, acceptanceCount: missionPlanDraft.acceptanceCriteria.length, dataEgress: missionPlanDraft.dataEgress },
    workItemIds: workItems.map((item) => item.id),
    runId: run.id,
    parallelRoles: {
      count: runningItems.length,
      statuses: runningItems.map((item) => item?.status),
      runIds: parallelRuns.map((item) => item.id)
    },
    routeReceipt: {
      runId: boundRun.id,
      policyDigest: boundRun.routingPolicy?.policyDigest,
      initialTarget: routePolicy.initialTarget,
      frozenAt: routePolicy.frozenAt,
      independentReadback: readback.status
    },
    contextPack: {
      usageRatio: contextUsage.usageRatio,
      pressure: contextUsage.pressure,
      keepFrom: contextBoundary.keepFrom,
      olderCount: contextBoundary.olderCount,
      recentCount: contextBoundary.recentCount,
      compressionBoundary: 'user-message'
    },
    proofPackPath,
    recovery: {
      failedStatus: failedRun.status,
      recoveredStatus: recovered.recoveredRun.status,
      recoveryCount: recovered.recoveredRun.recoveryCount
    },
    chain: ['ProjectWorkspace', 'Goal', 'WorkItem', 'TaskRun', 'WorkflowRun', 'SupervisorRun', 'Artifact', 'Evidence', 'Acceptance'],
    artifactId: artifact.id,
    artifactLocationId: artifactLocation.id,
    evidenceId: evidence.evidenceId,
    acceptanceId: passedAcceptance.id,
    acceptanceStatus: passedAcceptance.status,
    digest: createHash('sha256').update(JSON.stringify({ projectId, goal, workItems, parallelRuns, boundRun, artifact, evidence })).digest('hex')
  }
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(proofPackPath, `${JSON.stringify({ ...proofPack, generatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  writeFileSync(reportPath, `${JSON.stringify({ ...result, generatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(result, null, 2))
} finally {
  rmSync(rootDir, { recursive: true, force: true })
}
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
