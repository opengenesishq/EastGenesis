#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter)
require('node:module').Module._initPaths()

if (process.argv[2] === '--restart-probe') {
  const payload = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'))
  await runRestartProbe(payload)
  process.exit(0)
}
if (process.argv[2] === '--timezone-probe') {
  const payload = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'))
  await runTimezoneProbe(payload)
  process.exit(0)
}

const runId = new Date().toISOString().replace(/[:.]/g, '-')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-office-delivery-'))
const outDir = path.join(tempRoot, 'compiled')
const userData = path.join(tempRoot, 'user-data')
const workspaceRoot = path.join(tempRoot, 'workspace')
const reportRoot = path.join(repoRoot, 'test-results', 'office-delivery')
const reportDir = path.join(reportRoot, runId)
const retainedArtifactDir = path.join(reportDir, 'artifacts')
process.env.CAOGEN_USER_DATA = userData

const report = {
  schemaVersion: 1,
  runId,
  status: 'failed',
  sourceRevision: gitOutput(['rev-parse', 'HEAD']),
  worktreeStatusCount: gitOutput(['status', '--porcelain']).split('\n').filter(Boolean).length,
  checks: [],
  artifacts: [],
  summary: {},
  failures: []
}

try {
  mkdirSync(userData, { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(retainedArtifactDir, { recursive: true })
  compileSources()
  installElectronStub()
  await runOfficeDeliveryGate()
  report.status = 'passed'
} catch (error) {
  report.failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
} finally {
  mkdirSync(reportDir, { recursive: true })
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), serialized, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), serialized, 'utf8')
  rmSync(tempRoot, { recursive: true, force: true })
}

console.log(JSON.stringify({
  status: report.status,
  runId,
  checks: report.checks.length,
  summary: report.summary,
  failures: report.failures,
  reportDir
}, null, 2))

async function runOfficeDeliveryGate() {
  const workspaceApi = await importCompiled('main/project-workspace/index.js')
  const workspaceCommands = await importCompiled('main/project-workspace/command-service.js')
  const snapshotApi = await importCompiled('main/task/task-snapshot.js')
  const effectRuntime = await importCompiled('main/task/effect-runtime.js')
  const runtimeRegistry = await importCompiled('main/task/task-runtime-registry.js')
  const officeApi = await importCompiled('main/agent/tools/office-artifact.js')
  const officeCheckApi = await importCompiled('main/agent/tools/office-self-check.js')
  const lifecycleApi = await importCompiled('main/task/artifact-lifecycle-api.js')
  const producerApi = await importCompiled('main/task/artifact-lifecycle-producer.js')
  const idempotencyApi = await importCompiled('main/task/tool-idempotency.js')
  const workflowApi = await importCompiled('main/task/workflow-ledger-api.js')
  const handoffApi = await importCompiled('main/task/workflow-stage-handoff.js')

  const defaultLifecycleRoots = lifecycleApi.resolveLifecycleRoots({ workflowRoot: userData })
  assertEqual(defaultLifecycleRoots.workflowRoot, userData, 'Artifact lifecycle workflow root')
  assertEqual(defaultLifecycleRoots.workspaceRoot, userData, 'Artifact lifecycle default ProjectWorkspace root')
  check('Artifact lifecycle defaults ProjectWorkspace ownership to the active workflow user-data root')

  const fixture = await seedCanonicalRun(workspaceApi, workspaceCommands, snapshotApi)
  runtimeRegistry.taskRuntimeRegistry.set(fixture.run.sessionId, fixture.run)
  check('canonical Project, Goal, WorkItem, Session, and Run are persisted before Office execution')

  verifyCrossTimezoneDeterminism()
  check('approval-time output identities are stable across UTC, Asia/Shanghai, and America/Los_Angeles')

  await verifyPreExecutionGuards({ fixture, effectRuntime, officeApi })

  const deliveries = []
  for (const specification of officeSpecifications()) {
    deliveries.push(await produceOfficeArtifact({
      specification,
      fixture,
      effectRuntime,
      officeApi,
      officeCheckApi,
      lifecycleApi,
      workflowApi
    }))
  }
  const replayTarget = await officeApi.describeOfficeArtifactReplayTarget(
    deliveries[0].specification.input,
    workspaceRoot
  )
  assertEqual(replayTarget.kind, deliveries[0].handle.target.kind, 'Office replay target kind')
  assertEqual(
    JSON.stringify(replayTarget.rootIdentity),
    JSON.stringify(deliveries[0].handle.target.rootIdentity),
    'Office replay root identity'
  )
  assertEqual(
    replayTarget.relativePath,
    deliveries[0].handle.target.relativePath,
    'Office replay relative path'
  )
  check('existing Office outputs retain the same replay resource identity without permitting overwrite')
  await verifyLegacyProjectOfficeDelivery({
    effectRuntime,
    lifecycleApi,
    officeApi,
    runtimeRegistry,
    snapshotApi,
    workflowApi,
    workspaceApi
  })
  assert(
    deliveries.every(({ handle, generated }) =>
      handle.target.expectedSha256 === generated.sha256 && handle.target.expectedBytes === generated.bytes),
    'all Office outputs must match their approval-time frozen byte identity'
  )
  check('all four Office formats regenerate the exact bytes frozen before approval, including delayed execution')

  const failedDelivery = await produceFailedOfficeArtifact({
    fixture,
    effectRuntime,
    officeApi,
    lifecycleApi,
    workflowApi
  })
  const legacyEffectFixture = await verifyLegacyEffectMigration({
    sourceEffect: deliveries[0].effect,
    fixture,
    snapshotApi,
    effectRuntime,
    lifecycleApi,
    idempotencyApi
  })

  const handoffFixture = await verifyCanonicalDeliveryChain({
    deliveries,
    failedDelivery,
    fixture,
    lifecycleApi,
    workflowApi,
    workspaceApi,
    workspaceCommands,
    handoffApi
  })
  await verifyRestartReplay({
    deliveries,
    failedDelivery,
    fixture,
    snapshotApi,
    effectRuntime,
    runtimeRegistry,
    lifecycleApi,
    workflowApi,
    workspaceApi,
    handoffFixture,
    legacyEffectFixture
  })
  await verifyFailureBoundaries({
    deliveries,
    fixture,
    lifecycleApi,
    producerApi,
    snapshotApi,
    officeApi,
    officeCheckApi
  })

  report.summary = {
    formats: deliveries.length,
    confirmedEffects: deliveries.length + 2,
    outputBoundConfirmedEffects: deliveries.length + 1,
    quarantinedLegacyEffects: 1,
    canonicalArtifacts: deliveries.length + 3,
    passedAcceptances: deliveries.length + 1,
    handoffEligiblePassedAcceptances: deliveries.length,
    failedAcceptances: 1,
    evidenceRecords: deliveries.length + 2,
    retainedArtifacts: report.artifacts.length,
    negativePaths: report.checks.filter((item) => item.kind === 'negative').length,
    restartReplay: 'passed',
    stageHandoff: 'passed',
    runtimeOnlyProvenance: deliveries.filter((item) => item.specification.input.source_refs === undefined).length
  }
}

async function verifyLegacyProjectOfficeDelivery(input) {
  const {
    effectRuntime,
    lifecycleApi,
    officeApi,
    runtimeRegistry,
    snapshotApi,
    workflowApi,
    workspaceApi
  } = input
  const projectId = 'project-legacy-office'
  const sessionId = 'session-legacy-office'
  const run = {
    schemaVersion: 1,
    id: 'run-legacy-office',
    sessionId,
    taskId: sessionId,
    status: 'executing',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 2_000,
    updatedAt: 2_001,
    steps: [],
    toolExecutions: [],
    effects: []
  }
  const legacyRoot = path.join(workspaceRoot, 'legacy-project')
  mkdirSync(legacyRoot, { recursive: true })
  const snapshot = snapshotApi.buildTaskSnapshot({
    meta: {
      id: sessionId,
      title: 'Legacy local Project Office delivery',
      cwd: legacyRoot,
      projectId,
      model: 'synthetic-office-model',
      providerId: 'synthetic-office-provider',
      permissionMode: 'default',
      status: 'running',
      sdkSessionId: 'sdk-legacy-office-required',
      costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      contextTokens: 0,
      createdAt: run.createdAt
    },
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run,
    now: run.updatedAt
  })
  const persisted = await snapshotApi.saveTaskSnapshot(snapshot, userData)
  assert(persisted.run, 'legacy Project Office Run must persist')
  runtimeRegistry.taskRuntimeRegistry.set(sessionId, persisted.run)
  const execution = {
    sessionId,
    cwd: legacyRoot,
    toolUseId: 'office-legacy-project-document',
    toolName: 'create_document',
    toolInput: {
      path: 'deliverables/legacy-project.docx',
      title: 'Legacy Project Office Delivery',
      paragraphs: ['A normal local Project can deliver Office output without a ProjectWorkspace record.']
    }
  }
  const handle = await effectRuntime.prepareEffectExecution(execution)
  assert(handle?.target.kind === 'office_artifact', 'legacy Project must freeze an Office target')
  await effectRuntime.markEffectExecutionStarted(handle, execution)
  const generated = await officeApi.executeOfficeArtifactTool(
    execution.toolName,
    execution.toolInput,
    legacyRoot,
    handle.target
  )
  const effect = await effectRuntime.completeEffectExecution(handle, {
    ok: true,
    output: JSON.stringify(generated)
  })
  assertEqual(effect?.status, 'confirmed', 'legacy Project Office Effect status')
  const lifecycle = await lifecycleApi.getPersistedArtifactLifecycle(
    `artifact:office:${effect.id}`,
    userData
  )
  assert(lifecycle, 'legacy Project Office Artifact lifecycle')
  assertEqual(lifecycle.provenance, 'legacy-derived', 'legacy Project Artifact provenance')
  assertEqual(lifecycle.projectRevision, 0, 'legacy Project Artifact revision sentinel')
  const ledger = await workflowApi.listPersistedWorkflowLedger({ projectId, limit: 100 }, userData)
  assertEqual(
    ledger.acceptances.items.find((candidate) => candidate.id === `acceptance:artifact:office:${effect.id}`)?.status,
    'passed',
    'legacy Project Office Acceptance status'
  )
  const workspaceStore = new workspaceApi.ProjectWorkspaceStore(userData)
  await workspaceStore.open()
  assertEqual(await workspaceStore.getWorkspace(projectId), undefined, 'legacy ProjectWorkspace remains absent')
  await lifecycleApi.verifyPersistedArtifactLifecycle(userData)
  check('legacy local Project crosses confirmed Office Effect into Artifact, Evidence, and passed Acceptance')
}

async function verifyPreExecutionGuards({ fixture, effectRuntime, officeApi }) {
  const existingPath = path.join(workspaceRoot, 'deliverables', 'existing.docx')
  mkdirSync(path.dirname(existingPath), { recursive: true })
  writeFileSync(existingPath, 'historical artifact\n', 'utf8')
  const historical = readFileSync(existingPath)
  await assertRejects(
    () => effectRuntime.prepareEffectExecution({
      sessionId: fixture.run.sessionId,
      cwd: workspaceRoot,
      toolUseId: 'office-existing-file',
      toolName: 'create_document',
      toolInput: {
        path: 'deliverables/existing.docx',
        title: 'Must not overwrite',
        paragraphs: ['new content']
      }
    }),
    /存在|覆盖|Artifact/i,
    'pre-existing Office output must be rejected before Effect preparation'
  )
  assertBufferEqual(readFileSync(existingPath), historical, 'pre-existing Office bytes')
  check('pre-existing output is never overwritten', 'negative')

  const baseInput = {
    path: 'deliverables/drift.docx',
    title: 'Frozen proposal',
    paragraphs: ['approved content'],
    source_refs: ['inputs/source.md']
  }
  const execution = {
    sessionId: fixture.run.sessionId,
    cwd: workspaceRoot,
    toolUseId: 'office-input-drift',
    toolName: 'create_document',
    toolInput: baseInput
  }
  const handle = await effectRuntime.prepareEffectExecution(execution)
  assert(handle?.target.kind === 'office_artifact', 'input drift fixture must freeze an Office Effect target')
  await assertRejects(
    () => effectRuntime.markEffectExecutionStarted(handle, {
      ...execution,
      toolInput: { ...baseInput, paragraphs: ['changed after approval'] }
    }),
    /变化|失效|重新审批/i,
    'Office structured input drift must invalidate the approved Effect target'
  )
  assert(!existsSync(path.join(workspaceRoot, 'deliverables', 'drift.docx')), 'drifted input must not create a file')
  check('structured input drift after approval is abandoned before execution', 'negative')

  const raceInput = {
    path: 'deliverables/race.pdf',
    title: 'Approval race sentinel',
    sections: [{ heading: 'Sentinel', paragraphs: ['must survive'] }]
  }
  const raceExecution = {
    sessionId: fixture.run.sessionId,
    cwd: workspaceRoot,
    toolUseId: 'office-output-race',
    toolName: 'create_pdf',
    toolInput: raceInput
  }
  const raceHandle = await effectRuntime.prepareEffectExecution(raceExecution)
  assert(raceHandle?.target.kind === 'office_artifact', 'output race fixture must freeze an Office target')
  const sentinel = Buffer.from('created by another actor after approval\n')
  mkdirSync(path.dirname(raceHandle.target.workspacePath), { recursive: true })
  writeFileSync(raceHandle.target.workspacePath, sentinel)
  await assertRejects(
    () => effectRuntime.markEffectExecutionStarted(raceHandle, raceExecution),
    /存在|覆盖|变化|失效|重新审批/i,
    'output created after approval must invalidate Office execution'
  )
  assertBufferEqual(readFileSync(raceHandle.target.workspacePath), sentinel, 'post-approval race sentinel')
  check('output-file race after Effect preparation fails closed without overwrite', 'negative')

  const sourceDriftInput = {
    path: 'deliverables/source-drift.xlsx',
    title: 'Frozen source references',
    sheets: [{ name: 'Data', rows: [['value'], [1]] }],
    source_refs: ['inputs/source.md']
  }
  const sourceExecution = {
    sessionId: fixture.run.sessionId,
    cwd: workspaceRoot,
    toolUseId: 'office-source-ref-drift',
    toolName: 'create_spreadsheet',
    toolInput: sourceDriftInput
  }
  const sourceHandle = await effectRuntime.prepareEffectExecution(sourceExecution)
  assert(sourceHandle?.target.kind === 'office_artifact', 'source drift fixture must freeze an Office Effect target')
  await assertRejects(
    () => effectRuntime.markEffectExecutionStarted(sourceHandle, {
      ...sourceExecution,
      toolInput: { ...sourceDriftInput, source_refs: [] }
    }),
    /变化|失效|重新审批/i,
    'Office source reference drift must invalidate the approved Effect target'
  )
  check('source reference list is frozen by the durable Effect target', 'negative')

  const sourcePath = path.join(workspaceRoot, 'inputs', 'source.md')
  const sourceBytes = readFileSync(sourcePath)
  const contentDriftInput = {
    path: 'deliverables/source-content-drift.docx',
    title: 'Frozen source content',
    paragraphs: ['source digest must remain stable'],
    source_refs: ['inputs/source.md']
  }
  const contentDriftExecution = {
    sessionId: fixture.run.sessionId,
    cwd: workspaceRoot,
    toolUseId: 'office-source-content-drift',
    toolName: 'create_document',
    toolInput: contentDriftInput
  }
  const contentDriftHandle = await effectRuntime.prepareEffectExecution(contentDriftExecution)
  assert(contentDriftHandle?.target.kind === 'office_artifact', 'source content drift target')
  assertEqual(contentDriftHandle.target.sourceSnapshots?.length, 1, 'frozen source snapshot count')
  writeFileSync(sourcePath, '# Mutated after approval\n', 'utf8')
  try {
    await assertRejects(
      () => effectRuntime.markEffectExecutionStarted(contentDriftHandle, contentDriftExecution),
      /变化|失效|重新审批/i,
      'source bytes changed after approval must invalidate Office execution'
    )
  } finally {
    writeFileSync(sourcePath, sourceBytes)
  }
  assert(
    !existsSync(path.join(workspaceRoot, 'deliverables', 'source-content-drift.docx')),
    'source content drift must not create an output'
  )
  check('source file identity, byte count, and digest are frozen across approval', 'negative')

  const approvedPdfInput = {
    path: 'deliverables/approved-content.pdf',
    title: 'Approved Office content',
    sections: [{ heading: 'Approved', paragraphs: ['Only these approved bytes may be confirmed.'] }]
  }
  const approvedPdfExecution = {
    sessionId: fixture.run.sessionId,
    cwd: workspaceRoot,
    toolUseId: 'office-valid-but-foreign-output',
    toolName: 'create_pdf',
    toolInput: approvedPdfInput
  }
  const approvedPdfHandle = await effectRuntime.prepareEffectExecution(approvedPdfExecution)
  assert(approvedPdfHandle?.target.kind === 'office_artifact', 'foreign-output fixture target')
  await effectRuntime.markEffectExecutionStarted(approvedPdfHandle, approvedPdfExecution)
  const foreignPdfInput = {
    path: 'deliverables/foreign-content.pdf',
    title: 'Different valid Office content',
    sections: [{ heading: 'Foreign', paragraphs: ['This is valid PDF, but it was never approved.'] }]
  }
  const foreignPdfTarget = await officeApi.buildOfficeArtifactEffectTarget(
    'create_pdf',
    foreignPdfInput,
    workspaceRoot
  )
  const foreignPdf = await officeApi.executeOfficeArtifactTool(
    'create_pdf',
    foreignPdfInput,
    workspaceRoot,
    foreignPdfTarget
  )
  mkdirSync(path.dirname(approvedPdfHandle.target.workspacePath), { recursive: true })
  writeFileSync(approvedPdfHandle.target.workspacePath, readFileSync(foreignPdf.path))
  const unresolvedForeign = await effectRuntime.completeEffectExecution(approvedPdfHandle, {
    ok: false,
    output: 'synthetic crash after a different valid PDF occupied the approved path'
  })
  assertEqual(unresolvedForeign?.status, 'waiting_reconciliation', 'valid but foreign PDF reconciliation')
  const foreignReconciliation = await officeApi.reconcileOfficeArtifactEffectTarget(approvedPdfHandle.target)
  assertEqual(foreignReconciliation.kind, 'unresolved', 'valid but foreign PDF direct reconciliation')
  check('structurally valid but unapproved same-format bytes remain unresolved', 'negative')

  const markerOnlyPath = path.join(workspaceRoot, 'deliverables', 'marker-only.docx')
  const markerOnlyBytes = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('word/document.xml[Content_Types].xml_rels/.rels', 'utf8')
  ])
  writeFileSync(markerOnlyPath, markerOnlyBytes)
  const markerOnlyCheck = await (await importCompiled('main/agent/tools/office-self-check.js')).runOfficeSelfCheck({
    workspacePath: markerOnlyPath,
    expectedSha256: sha256(markerOnlyBytes),
    artifactKind: 'document',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sourceRefs: [],
    runtimeTraceable: true
  })
  assertEqual(markerOnlyCheck.ok, false, 'marker-only OOXML self-check')
  check('marker-only pseudo OOXML is rejected by ZIP central-directory and CRC parsing', 'negative')

  assert(officeApi.isOfficeArtifactTool('create_document'), 'document tool registration')
  assert(officeApi.isOfficeArtifactTool('create_spreadsheet'), 'spreadsheet tool registration')
  assert(officeApi.isOfficeArtifactTool('create_presentation'), 'presentation tool registration')
  assert(officeApi.isOfficeArtifactTool('create_pdf'), 'PDF tool registration')
  check('all four Office tools share the production Effect target builder')
}

async function produceOfficeArtifact(input) {
  const { specification, fixture, effectRuntime, officeApi, officeCheckApi, lifecycleApi, workflowApi } = input
  const execution = {
    sessionId: fixture.run.sessionId,
    cwd: workspaceRoot,
    toolUseId: `office-golden-${specification.kind}`,
    toolName: specification.toolName,
    toolInput: specification.input
  }
  const handle = await effectRuntime.prepareEffectExecution(execution)
  assert(handle?.target.kind === 'office_artifact', `${specification.kind} must freeze office_artifact target`)
  assertEqual(handle.target.artifactKind, specification.kind, `${specification.kind} target kind`)
  await effectRuntime.markEffectExecutionStarted(handle, execution)
  if (specification.kind === 'document') {
    await new Promise((resolve) => setTimeout(resolve, 2_100))
  }
  const generated = await officeApi.executeOfficeArtifactTool(
    specification.toolName,
    specification.input,
    workspaceRoot,
    handle.target
  )
  assertEqual(generated.artifactKind, specification.kind, `${specification.kind} generated kind`)
  assertEqual(generated.mediaType, specification.mediaType, `${specification.kind} media type`)
  assertEqual(generated.sha256, sha256(readFileSync(generated.path)), `${specification.kind} generated digest`)
  await verifyFormatCanBeParsed(specification, generated.path)

  const effect = await effectRuntime.completeEffectExecution(handle, {
    ok: true,
    output: JSON.stringify(generated)
  })
  assertEqual(effect?.status, 'confirmed', `${specification.kind} Effect status`)
  const artifactId = `artifact:office:${effect.id}`
  const lifecycle = await lifecycleApi.getPersistedArtifactLifecycle(artifactId, userData)
  assert(lifecycle, `${specification.kind} canonical Artifact lifecycle`)
  assertEqual(lifecycle.kind, specification.kind, `${specification.kind} lifecycle kind`)
  assertEqual(lifecycle.digest, generated.sha256, `${specification.kind} lifecycle digest`)
  assertEqual(lifecycle.runId, fixture.run.id, `${specification.kind} lifecycle Run`)

  const selfCheck = await officeCheckApi.runOfficeSelfCheck({
    workspacePath: generated.path,
    expectedSha256: lifecycle.digest,
    artifactKind: specification.kind,
    mediaType: specification.mediaType,
    sourceRefs: handle.target.sourceRefs,
    sourceSnapshots: handle.target.sourceSnapshots,
    runtimeTraceable: true
  })
  assertEqual(selfCheck.ok, true, `${specification.kind} self-check`)
  assertEqual(selfCheck.digestMatch, true, `${specification.kind} self-check digest`)
  assertEqual(selfCheck.sourceTraceable, true, `${specification.kind} self-check provenance`)
  assertEqual(
    handle.target.sourceSnapshots?.length,
    handle.target.sourceRefs.length,
    `${specification.kind} source snapshot coverage`
  )

  const acceptanceId = `acceptance:artifact:office:${effect.id}`
  const evidenceId = `evidence:artifact:office:${effect.id}`
  const criterionId = `criterion:artifact:office:${effect.id}:deliverable`
  const ledger = await workflowApi.listPersistedWorkflowLedger({ projectId: fixture.projectId, limit: 500 }, userData)
  const acceptance = ledger.acceptances.items.find((candidate) => candidate.id === acceptanceId)
  const link = ledger.evidenceLinks.items.find((candidate) =>
    candidate.id === `${acceptanceId}:link:${criterionId}`)
  const evidence = (await workflowApi.listWorkflowEvidence({
    projectId: fixture.projectId,
    workItemId: fixture.workItemId
  }, userData)).find((candidate) => candidate.evidenceId === evidenceId)
  assertEqual(acceptance?.status, 'passed', `${specification.kind} Acceptance status`)
  assert(acceptance?.evidenceRefs.includes(evidenceId), `${specification.kind} Acceptance Evidence ref`)
  assertEqual(evidence?.artifactId, artifactId, `${specification.kind} Evidence Artifact`)
  assertEqual(evidence?.runId, fixture.run.id, `${specification.kind} Evidence Run`)
  assertEqual(
    evidence?.contentDigest,
    lifecycle.digest.slice('sha256:'.length),
    `${specification.kind} Evidence digest`
  )
  assertEqual(link?.artifactId, artifactId, `${specification.kind} Evidence link Artifact`)
  assertEqual(link?.acceptanceId, acceptanceId, `${specification.kind} Evidence link Acceptance`)
  assertEqual(link?.relation, 'verifies', `${specification.kind} Evidence link relation`)

  const retainedPath = path.join(retainedArtifactDir, path.basename(generated.path))
  copyFileSync(generated.path, retainedPath)
  report.artifacts.push({
    kind: specification.kind,
    mediaType: specification.mediaType,
    bytes: generated.bytes,
    sha256: generated.sha256,
    artifactId,
    evidenceId,
    acceptanceId,
    sourceRefs: handle.target.sourceRefs,
    retainedPath: path.relative(repoRoot, retainedPath).split(path.sep).join('/')
  })
  check(`${specification.kind} crosses confirmed Effect into Artifact, Evidence, and passed Acceptance`)
  return { specification, handle, generated, effect, lifecycle, acceptance, evidence, link }
}

async function produceFailedOfficeArtifact({ fixture, effectRuntime, officeApi, lifecycleApi, workflowApi }) {
  const toolInput = {
    path: 'deliverables/rejected-source-drift.docx',
    title: 'Rejected source-drift Office output',
    paragraphs: ['The output is exact, while its approved source changes before reconciliation.'],
    source_refs: ['inputs/failure-source.md']
  }
  const execution = {
    sessionId: fixture.run.sessionId,
    cwd: workspaceRoot,
    toolUseId: 'office-failed-acceptance',
    toolName: 'create_document',
    toolInput
  }
  const handle = await effectRuntime.prepareEffectExecution(execution)
  assert(handle?.target.kind === 'office_artifact', 'failed Acceptance fixture must freeze an Office target')
  await effectRuntime.markEffectExecutionStarted(handle, execution)
  const generated = await officeApi.executeOfficeArtifactTool(
    'create_document',
    toolInput,
    workspaceRoot,
    handle.target
  )
  assertEqual(generated.sha256, handle.target.expectedSha256, 'failed Acceptance exact output digest')
  const sourcePath = handle.target.sourceRefs[0]
  writeFileSync(sourcePath, '# Source changed after output publication\n', 'utf8')
  const unresolved = await effectRuntime.completeEffectExecution(handle, {
    ok: false,
    output: 'synthetic crash after exact output publication and source drift'
  })
  assertEqual(unresolved?.status, 'waiting_reconciliation', 'source-drift Office Effect before manual resolution')
  const resolvedSnapshot = await effectRuntime.resolvePersistedTaskEffect(
    fixture.run.sessionId,
    unresolved.id,
    unresolved.revision,
    'confirmed_applied'
  )
  const effect = resolvedSnapshot.run?.effects.find((candidate) => candidate.id === unresolved.id)
  assertEqual(effect?.status, 'confirmed', 'manually confirmed source-drift Office Effect')
  const artifactId = `artifact:office:${unresolved.id}`
  const acceptanceId = `acceptance:artifact:office:${unresolved.id}`
  const evidenceId = `evidence:artifact:office:${unresolved.id}`
  const lifecycle = await lifecycleApi.getPersistedArtifactLifecycle(artifactId, userData)
  assert(lifecycle, 'failed Office Acceptance must retain the exact observed Artifact for audit')
  const ledger = await workflowApi.listPersistedWorkflowLedger({ projectId: fixture.projectId, limit: 500 }, userData)
  const acceptance = ledger.acceptances.items.find((candidate) => candidate.id === acceptanceId)
  const evidence = (await workflowApi.listWorkflowEvidence({ projectId: fixture.projectId }, userData))
    .find((candidate) => candidate.evidenceId === evidenceId)
  assertEqual(acceptance?.status, 'failed', 'source-drift Office Acceptance status')
  assertEqual(evidence?.metadata?.selfCheck?.ok, false, 'source-drift Office Evidence self-check')
  assertEqual(evidence?.artifactId, artifactId, 'source-drift Office Evidence Artifact')
  const retainedPath = path.join(retainedArtifactDir, path.basename(handle.target.workspacePath))
  copyFileSync(handle.target.workspacePath, retainedPath)
  report.artifacts.push({
    kind: 'document',
    disposition: 'rejected',
    mediaType: handle.target.mediaType,
    bytes: readFileSync(handle.target.workspacePath).byteLength,
    sha256: lifecycle.digest,
    artifactId,
    evidenceId,
    acceptanceId,
    sourceRefs: handle.target.sourceRefs,
    retainedPath: path.relative(repoRoot, retainedPath).split(path.sep).join('/')
  })
  check('manually confirmed exact output with drifted provenance persists failed Acceptance', 'negative')
  return { handle, effect, lifecycle, acceptance, evidence, artifactId, acceptanceId, evidenceId }
}

async function verifyLegacyEffectMigration(input) {
  const { sourceEffect, fixture, snapshotApi, effectRuntime, lifecycleApi, idempotencyApi } = input
  assert(sourceEffect.target.kind === 'office_artifact', 'legacy migration source must be an Office Effect')
  const persisted = await snapshotApi.getTaskSnapshot(fixture.run.sessionId, userData)
  assert(persisted?.run, 'legacy migration fixture must read the persisted canonical Run')

  const now = Date.now()
  const confirmedTarget = legacyOfficeTarget(
    sourceEffect.target,
    'deliverables/legacy-confirmed-effect.docx'
  )
  mkdirSync(path.dirname(confirmedTarget.workspacePath), { recursive: true })
  copyFileSync(sourceEffect.target.workspacePath, confirmedTarget.workspacePath)
  const confirmedEffect = legacyOfficeEffect({
    sourceEffect,
    target: confirmedTarget,
    id: 'effect-office-legacy-confirmed',
    toolUseId: 'office-legacy-confirmed',
    status: 'confirmed',
    now,
    idempotencyApi
  })

  const waitingTarget = legacyOfficeTarget(
    sourceEffect.target,
    'deliverables/legacy-waiting-effect.docx'
  )
  assert(!existsSync(waitingTarget.workspacePath), 'legacy waiting fixture output must start absent')
  copyFileSync(sourceEffect.target.workspacePath, waitingTarget.workspacePath)
  const waitingEffect = legacyOfficeEffect({
    sourceEffect,
    target: waitingTarget,
    id: 'effect-office-legacy-waiting',
    toolUseId: 'office-legacy-waiting',
    status: 'waiting_reconciliation',
    now: now + 1,
    idempotencyApi
  })

  assertEqual(
    idempotencyApi.stableValueDigest(confirmedEffect.target),
    confirmedEffect.targetDigest,
    'legacy confirmed target digest'
  )
  assertEqual(
    idempotencyApi.stableValueDigest({
      toolName: waitingEffect.toolName,
      targetDigest: waitingEffect.targetDigest,
      inputDigest: waitingEffect.inputDigest
    }),
    waitingEffect.intentDigest,
    'legacy waiting intent digest'
  )

  const seeded = await snapshotApi.saveTaskSnapshot({
    ...persisted,
    updatedAt: now + 2,
    run: {
      ...persisted.run,
      revision: persisted.run.revision + 1,
      updatedAt: now + 2,
      effects: [...(persisted.run.effects ?? []), confirmedEffect, waitingEffect]
    }
  }, userData)
  assertEqual(
    seeded.run?.effects.filter((effect) =>
      effect.target.kind === 'office_artifact' &&
      (effect.id === confirmedEffect.id || effect.id === waitingEffect.id)
    ).length,
    2,
    'persisted legacy Office Effect fixture count'
  )

  const recovered = await effectRuntime.reconcilePersistedTaskSnapshot(seeded)
  const recoveredConfirmed = recovered.run?.effects.find((effect) => effect.id === confirmedEffect.id)
  const recoveredWaiting = recovered.run?.effects.find((effect) => effect.id === waitingEffect.id)
  assertEqual(recoveredConfirmed?.status, 'confirmed', 'legacy confirmed Effect after recovery')
  assertEqual(recoveredWaiting?.status, 'waiting_reconciliation', 'legacy waiting Effect after recovery')
  const confirmedArtifactId = `artifact:office:${confirmedEffect.id}`
  const waitingArtifactId = `artifact:office:${waitingEffect.id}`
  assertEqual(
    await lifecycleApi.getPersistedArtifactLifecycle(confirmedArtifactId, userData),
    null,
    'legacy confirmed Effect quarantine Artifact'
  )
  check('restart recovery reads but quarantines a confirmed legacy Office Effect without creating an Artifact', 'negative')

  const beforeRejectedConfirmation = await snapshotApi.getTaskSnapshot(fixture.run.sessionId, userData)
  const durableWaiting = beforeRejectedConfirmation?.run?.effects.find((effect) => effect.id === waitingEffect.id)
  assertEqual(durableWaiting?.status, 'waiting_reconciliation', 'durable legacy waiting Effect before confirmation')
  let beforePersistCalled = false
  await assertRejects(
    () => effectRuntime.resolvePersistedTaskEffect(
      fixture.run.sessionId,
      waitingEffect.id,
      durableWaiting.revision,
      'confirmed_applied',
      { beforePersist: () => { beforePersistCalled = true } }
    ),
    /旧版|输出绑定|重新生成|重新审批/i,
    'legacy waiting Office Effect must reject confirmed_applied before persistence'
  )
  assertEqual(beforePersistCalled, false, 'legacy confirmed_applied beforePersist callback')
  const afterRejectedConfirmation = await snapshotApi.getTaskSnapshot(fixture.run.sessionId, userData)
  const unchangedWaiting = afterRejectedConfirmation?.run?.effects.find((effect) => effect.id === waitingEffect.id)
  assertEqual(unchangedWaiting?.status, 'waiting_reconciliation', 'legacy waiting status after rejected confirmation')
  assertEqual(unchangedWaiting?.revision, durableWaiting.revision, 'legacy waiting revision after rejected confirmation')
  assertEqual(
    idempotencyApi.stableValueDigest(unchangedWaiting),
    idempotencyApi.stableValueDigest(durableWaiting),
    'legacy waiting durable record after rejected confirmation'
  )
  assertEqual(
    await lifecycleApi.getPersistedArtifactLifecycle(waitingArtifactId, userData),
    null,
    'rejected legacy waiting Effect Artifact'
  )
  check('legacy waiting Effect cannot be confirmed as applied and remains byte-for-byte unpersisted', 'negative')

  const abandonedSnapshot = await effectRuntime.resolvePersistedTaskEffect(
    fixture.run.sessionId,
    waitingEffect.id,
    unchangedWaiting.revision,
    'confirmed_not_applied'
  )
  const abandoned = abandonedSnapshot.run?.effects.find((effect) => effect.id === waitingEffect.id)
  assertEqual(abandoned?.status, 'abandoned', 'legacy waiting Effect authorized regeneration state')
  assert(abandoned?.evidence.some((item) => item.kind === 'retry_authorized'),
    'legacy waiting Effect must retain retry authorization evidence')
  assertEqual(
    await lifecycleApi.getPersistedArtifactLifecycle(waitingArtifactId, userData),
    null,
    'abandoned legacy waiting Effect Artifact'
  )
  check('legacy waiting Effect can be marked not applied and abandoned for explicit regeneration')

  return {
    confirmedEffectId: confirmedEffect.id,
    confirmedArtifactId,
    waitingEffectId: waitingEffect.id,
    waitingArtifactId
  }
}

function legacyOfficeTarget(sourceTarget, relativePath) {
  const target = {
    ...sourceTarget,
    relativePath,
    workspacePath: path.join(sourceTarget.rootPath, relativePath)
  }
  delete target.outputBindingVersion
  delete target.expectedSha256
  delete target.expectedBytes
  delete target.sourceSnapshots
  return target
}

function legacyOfficeEffect(input) {
  const { sourceEffect, target, id, toolUseId, status, now, idempotencyApi } = input
  const targetDigest = idempotencyApi.stableValueDigest(target)
  const terminal = status === 'confirmed'
  return {
    ...sourceEffect,
    id,
    effectKey: `effect-v1:legacy:${id}`,
    resourceKey: `resource-v1:legacy:${id}`,
    toolUseId,
    status,
    target,
    targetDigest,
    intentDigest: idempotencyApi.stableValueDigest({
      toolName: sourceEffect.toolName,
      targetDigest,
      inputDigest: sourceEffect.inputDigest
    }),
    lease: sourceEffect.lease
      ? {
          ...sourceEffect.lease,
          id: `lease:${id}`,
          ownerId: 'office-delivery-legacy-fixture',
          acquiredAt: now - 2,
          expiresAt: now - 1,
          releasedAt: now
        }
      : undefined,
    evidence: sourceEffect.evidence.map((item, index) => ({
      ...item,
      id: `evidence:${id}:${index}`,
      observedAt: now + index,
      verifier: 'office-delivery-legacy-fixture'
    })),
    revision: sourceEffect.revision,
    createdAt: now,
    updatedAt: now,
    terminalAt: terminal ? now : undefined,
    error: terminal ? undefined : 'synthetic legacy Effect awaiting manual reconciliation'
  }
}

async function verifyCanonicalDeliveryChain(input) {
  const {
    deliveries,
    failedDelivery,
    fixture,
    lifecycleApi,
    workflowApi,
    workspaceApi,
    workspaceCommands,
    handoffApi
  } = input
  const artifactIds = new Set(deliveries.map((item) => item.lifecycle.artifactId))
  const store = new workspaceApi.ProjectWorkspaceStore(userData)
  await store.open()
  const commands = workspaceCommands.createProjectWorkspaceCommandService(store, { rootDir: userData })
  const delivery = await store.getWorkItem(fixture.workItemId)
  assert(delivery, 'delivery WorkItem must survive producer updates')
  for (const artifactId of artifactIds) {
    assert(delivery.artifactRefs.includes(artifactId), `delivery WorkItem must reference ${artifactId}`)
  }
  assert(
    !delivery.artifactRefs.includes(failedDelivery.artifactId),
    'failed Office Artifact must not attach to the producing WorkItem'
  )
  check('all four canonical Artifacts are attached to the producing WorkItem')
  check('failed Office Artifact remains auditable but is excluded from WorkItem handoff', 'negative')

  const defaultRootArtifact = deliveries[0].lifecycle
  const previousUserDataOverride = process.env.CAOGEN_USER_DATA
  process.env.CAOGEN_USER_DATA = path.join(tempRoot, 'wrong-project-workspace-default')
  try {
    await handoffApi.attachProducedArtifactToStage({
      artifactId: defaultRootArtifact.artifactId,
      projectId: defaultRootArtifact.projectId,
      workItemId: defaultRootArtifact.workItemId,
      runId: defaultRootArtifact.runId
    })
  } finally {
    if (previousUserDataOverride === undefined) delete process.env.CAOGEN_USER_DATA
    else process.env.CAOGEN_USER_DATA = previousUserDataOverride
  }
  check('installed-style Artifact handoff defaults to the active workflow user-data root')

  const localAcceptedDelivery = await commands.setWorkItemAcceptance(delivery.id, {
    status: 'passed',
    evidenceRefs: [deliveries[0].evidence.evidenceId],
    verifiedBy: 'office-delivery-required',
    verifiedAt: Date.now()
  }, { expectedRevision: delivery.revision })
  await assertRejects(
    () => commands.transitionWorkItem(
      localAcceptedDelivery.id,
      'done',
      { expectedRevision: localAcceptedDelivery.revision }
    ),
    /Acceptance|acceptance|验收|failed|失败/i,
    'failed Office Acceptance must block WorkItem completion'
  )
  const goal = await store.getGoal(fixture.goalId)
  assert(goal, 'Office Goal must persist')
  const localAcceptedGoal = await commands.setGoalAcceptance(goal.id, {
    status: 'passed',
    evidenceRefs: [deliveries[0].evidence.evidenceId],
    verifiedBy: 'office-delivery-required',
    verifiedAt: Date.now()
  }, { expectedRevision: goal.revision })
  await assertRejects(
    () => commands.transitionGoal(
      localAcceptedGoal.id,
      'completed',
      { expectedRevision: localAcceptedGoal.revision }
    ),
    /Acceptance|acceptance|验收|failed|失败/i,
    'failed Office Acceptance must block Goal completion'
  )
  check('failed Office Acceptance blocks both WorkItem and Goal completion', 'negative')

  const sourceDelivery = deliveries.find((item) => item.specification.kind === 'document')
  assert(sourceDelivery, 'document delivery is required for the pre-Acceptance crash fixture')
  const unacceptedArtifactId = 'artifact:office:acceptance-crash-window'
  const unacceptedPath = path.join(workspaceRoot, 'deliverables', 'acceptance-crash-window.docx')
  copyFileSync(sourceDelivery.generated.path, unacceptedPath)
  const unacceptedLifecycle = await lifecycleApi.registerPersistedArtifactLifecycle({
    id: unacceptedArtifactId,
    projectId: fixture.projectId,
    goalId: fixture.goalId,
    workItemId: fixture.workItemId,
    runId: fixture.run.id,
    lineageId: 'lineage:office:acceptance-crash-window',
    kind: 'document',
    title: 'Artifact persisted before Acceptance crash window',
    version: 1,
    provenance: 'explicit',
    mediaType: sourceDelivery.specification.mediaType,
    retention: { mode: 'retain' },
    content: {
      storageKind: 'source_ref',
      sourceRef: unacceptedPath,
      expectedDigest: sha256(readFileSync(unacceptedPath))
    },
    metadata: { fixture: 'artifact-before-acceptance' },
    createdAt: Date.now()
  }, userData)
  assertEqual(unacceptedLifecycle.lifecycle.artifactId, unacceptedArtifactId, 'pre-Acceptance Artifact persistence')
  const preAcceptanceLedger = await workflowApi.listPersistedWorkflowLedger({
    projectId: fixture.projectId,
    limit: 500
  }, userData)
  assert(
    !preAcceptanceLedger.evidenceLinks.items.some((link) =>
      link.artifactId === unacceptedArtifactId && link.acceptanceId),
    'pre-Acceptance crash fixture must not have an Acceptance link'
  )
  check('Artifact-only crash-window fixture is durably persisted without an Acceptance link', 'negative')

  const legacyArtifactId = 'artifact:office:legacy-output-binding'
  const legacyPath = path.join(workspaceRoot, 'deliverables', 'legacy-output-binding.docx')
  copyFileSync(sourceDelivery.generated.path, legacyPath)
  const legacyDigest = sha256(readFileSync(legacyPath))
  await lifecycleApi.registerPersistedArtifactLifecycle({
    id: legacyArtifactId,
    projectId: fixture.projectId,
    goalId: fixture.goalId,
    workItemId: fixture.workItemId,
    runId: fixture.run.id,
    lineageId: 'lineage:office:legacy-output-binding',
    kind: 'document',
    title: 'Legacy Office Artifact without deterministic output binding',
    version: 1,
    provenance: 'explicit',
    mediaType: sourceDelivery.specification.mediaType,
    retention: { mode: 'retain' },
    content: { storageKind: 'source_ref', sourceRef: legacyPath, expectedDigest: legacyDigest },
    metadata: { producer: 'office_delivery', effectId: 'legacy-office-effect' },
    createdAt: Date.now()
  }, userData)
  const legacyAcceptancePending = await workflowApi.saveWorkflowAcceptance({
    id: 'acceptance:office:legacy-output-binding',
    projectId: fixture.projectId,
    goalId: fixture.goalId,
    workItemId: fixture.workItemId,
    criteria: ['Legacy Office output was structurally accepted']
  }, userData)
  const legacyEvidence = await workflowApi.createWorkflowEvidence({
    evidenceId: 'evidence:office:legacy-output-binding',
    projectId: fixture.projectId,
    goalId: fixture.goalId,
    workItemId: fixture.workItemId,
    runId: fixture.run.id,
    artifactId: legacyArtifactId,
    kind: 'delivery_check',
    title: 'Legacy Office delivery evidence',
    summary: 'Synthetic pre-v1 binding evidence',
    contentDigest: legacyDigest.slice('sha256:'.length)
  }, userData, { source: 'runtime', verifier: 'legacy-office-fixture', observedAt: Date.now() })
  await workflowApi.createWorkflowEvidenceLink({
    id: 'link:office:legacy-output-binding',
    evidenceId: legacyEvidence.evidenceId,
    evidenceOrigin: 'workflow',
    projectId: fixture.projectId,
    goalId: fixture.goalId,
    workItemId: fixture.workItemId,
    runId: fixture.run.id,
    artifactId: legacyArtifactId,
    acceptanceId: legacyAcceptancePending.id,
    relation: 'verifies',
    createdAt: Date.now()
  }, userData)
  const legacyAcceptanceVerifying = await workflowApi.saveWorkflowAcceptance({
    ...legacyAcceptancePending,
    status: 'verifying',
    evidenceRefs: [legacyEvidence.evidenceId],
    revision: legacyAcceptancePending.revision + 1
  }, userData)
  const legacyAcceptancePassed = await workflowApi.saveWorkflowAcceptance({
    ...legacyAcceptanceVerifying,
    status: 'passed',
    verifier: 'legacy-office-fixture',
    verifiedAt: Date.now(),
    revision: legacyAcceptanceVerifying.revision + 1
  }, userData)
  assertEqual(legacyAcceptancePassed.status, 'passed', 'legacy Office fixture Acceptance status')
  check('legacy Office fixture retains passed Acceptance without a v1 output binding', 'negative')

  const downstream = await commands.createWorkItem({
    id: 'work-item-office-downstream',
    projectId: fixture.projectId,
    goalId: fixture.goalId,
    title: 'Review Office delivery',
    type: 'review',
    dependencyIds: [fixture.workItemId]
  })
  const handoff = await handoffApi.resolveWorkflowStageHandoff({
    projectId: fixture.projectId,
    workItemId: downstream.id,
    rootDir: userData
  })
  const handedOff = new Map(handoff.artifacts.map((item) => [item.artifact.id, item]))
  for (const artifactId of artifactIds) {
    assertEqual(handedOff.get(artifactId)?.source, 'dependency', `stage handoff source for ${artifactId}`)
  }
  assert(!handedOff.has(failedDelivery.artifactId), 'failed Office Artifact must not enter downstream handoff')
  assert(!handedOff.has(unacceptedArtifactId), 'Artifact without Acceptance must not enter downstream handoff')
  assert(!handedOff.has(legacyArtifactId), 'legacy Office Artifact without v1 output binding must not enter handoff')
  check('downstream WorkItem receives all four Office Artifacts through dependency handoff')
  check('Artifact persisted before Acceptance is isolated from current-process handoff', 'negative')
  check('legacy passed Office Artifact remains isolated until explicit v1 regeneration or review', 'negative')

  const edges = await workflowApi.listWorkflowArtifactEdges({ projectId: fixture.projectId, limit: 500 }, userData)
  const siblingEdges = edges.items.filter(
    (edge) => artifactIds.has(edge.fromArtifactId) && artifactIds.has(edge.toArtifactId)
  )
  assertEqual(siblingEdges.length, 0, 'same-Run Office sibling lineage edge count')
  check('same-Run Office outputs do not acquire fabricated cyclic lineage edges', 'negative')

  const ledger = await workflowApi.listPersistedWorkflowLedger({ projectId: fixture.projectId, limit: 500 }, userData)
  assertEqual(
    ledger.artifacts.items.filter((item) => artifactIds.has(item.id)).length,
    deliveries.length,
    'canonical Office Artifact count'
  )
  assertEqual(
    ledger.acceptances.items.filter((item) => deliveries.some((deliveryItem) => deliveryItem.acceptance.id === item.id && item.status === 'passed')).length,
    deliveries.length,
    'passed Office Acceptance count'
  )
  const evidence = await workflowApi.listWorkflowEvidence({ projectId: fixture.projectId }, userData)
  assertEqual(
    evidence.filter((item) => deliveries.some((deliveryItem) => deliveryItem.evidence.evidenceId === item.evidenceId)).length,
    deliveries.length,
    'Office Evidence count'
  )
  check('canonical ledger retains four non-duplicated Artifact/Evidence/Acceptance chains')

  const runtimeOnly = deliveries.find((item) => item.specification.input.source_refs === undefined)
  assert(runtimeOnly, 'one Office delivery must exercise runtime-only provenance')
  const runtimeArtifact = ledger.artifacts.items.find(
    (item) => item.id === runtimeOnly.lifecycle.artifactId
  )
  assertEqual(runtimeOnly.handle.target.sourceRefs.length, 0, 'runtime-only source refs')
  assertEqual(runtimeOnly.evidence.runId, fixture.run.id, 'runtime-only Evidence Run binding')
  assertEqual(runtimeArtifact?.metadata?.effectId, runtimeOnly.effect.id, 'runtime-only Artifact Effect binding')
  check('empty source_refs is accepted only with canonical Run, Effect, Artifact, and Evidence provenance')
  return { unacceptedArtifactId, legacyArtifactId, downstreamWorkItemId: downstream.id }
}

async function verifyRestartReplay(input) {
  const {
    deliveries,
    failedDelivery,
    fixture,
    lifecycleApi,
    workflowApi,
    workspaceApi,
    handoffFixture,
    legacyEffectFixture
  } = input
  const payload = Buffer.from(JSON.stringify({
    outDir,
    userData,
    sessionId: fixture.run.sessionId,
    projectId: fixture.projectId,
    workItemId: fixture.workItemId,
    passedArtifactIds: deliveries.map((item) => item.lifecycle.artifactId),
    passedAcceptanceIds: deliveries.map((item) => item.acceptance.id),
    failedArtifactId: failedDelivery.artifactId,
    failedAcceptanceId: failedDelivery.acceptanceId,
    unacceptedArtifactId: handoffFixture.unacceptedArtifactId,
    legacyArtifactId: handoffFixture.legacyArtifactId,
    downstreamWorkItemId: handoffFixture.downstreamWorkItemId,
    legacyConfirmedEffectId: legacyEffectFixture.confirmedEffectId,
    legacyConfirmedArtifactId: legacyEffectFixture.confirmedArtifactId,
    legacyWaitingEffectId: legacyEffectFixture.waitingEffectId
  })).toString('base64url')
  const probe = JSON.parse(execFileSync(
    process.execPath,
    [path.resolve(process.argv[1]), '--restart-probe', payload],
    { cwd: repoRoot, encoding: 'utf8' }
  ))
  assertEqual(
    probe.confirmedOfficeEffects,
    deliveries.length + 2,
    'confirmed Office Effects in fresh-process restart probe'
  )
  assertEqual(
    probe.outputBoundConfirmedOfficeEffects,
    deliveries.length + 1,
    'output-bound confirmed Office Effects in fresh-process restart probe'
  )
  assertEqual(probe.quarantinedLegacyOfficeEffects, 1, 'quarantined legacy Office Effects after restart')
  assertEqual(probe.legacyConfirmedEffectReadable, true, 'legacy confirmed Effect readability after restart')
  assertEqual(probe.legacyConfirmedArtifactPresent, false, 'legacy confirmed Effect Artifact isolation after restart')
  assertEqual(probe.legacyWaitingEffectStatus, 'abandoned', 'legacy waiting Effect disposition after restart')
  assert(probe.lifecycleArtifacts >= deliveries.length + 3, 'Artifact lifecycle verification in restart probe')
  assertEqual(probe.failedAcceptanceStatus, 'failed', 'failed Acceptance in restart probe')
  assertEqual(probe.passedAcceptanceCount, deliveries.length, 'passed Acceptance count in restart probe')
  assertEqual(probe.passedArtifactRefCount, deliveries.length, 'passed Artifact refs in restart probe')
  assertEqual(probe.failedArtifactAttached, false, 'failed Artifact exclusion in restart probe')
  assertEqual(probe.unacceptedArtifactHandedOff, false, 'pre-Acceptance Artifact handoff after restart')
  assertEqual(probe.legacyArtifactHandedOff, false, 'legacy Office Artifact handoff after restart')

  const verification = await lifecycleApi.verifyPersistedArtifactLifecycle(userData)
  assert(verification.artifacts >= deliveries.length + 3, 'Artifact lifecycle verification after restart')
  const ledger = await workflowApi.listPersistedWorkflowLedger({ projectId: fixture.projectId, limit: 500 }, userData)
  for (const item of deliveries) {
    assertEqual(
      ledger.artifacts.items.filter((candidate) => candidate.id === item.lifecycle.artifactId).length,
      1,
      `restart idempotency for ${item.specification.kind} Artifact`
    )
    assertEqual(
      ledger.acceptances.items.filter((candidate) => candidate.id === item.acceptance.id).length,
      1,
      `restart idempotency for ${item.specification.kind} Acceptance`
    )
  }
  assertEqual(
    ledger.acceptances.items.find((candidate) => candidate.id === failedDelivery.acceptanceId)?.status,
    'failed',
    'failed Office Acceptance after restart'
  )
  const reopened = new workspaceApi.ProjectWorkspaceStore(userData)
  await reopened.open()
  const workItem = await reopened.getWorkItem(fixture.workItemId)
  assert(workItem, 'producing WorkItem must reopen after restart')
  for (const item of deliveries) {
    assert(workItem.artifactRefs.includes(item.lifecycle.artifactId), `restart WorkItem Artifact ref ${item.lifecycle.artifactId}`)
  }
  assert(!workItem.artifactRefs.includes(failedDelivery.artifactId), 'failed Office Artifact ref after restart')
  check('fresh-process restart replay is idempotent and preserves Effects, Artifacts, Acceptances, and WorkItem refs')
  check('fresh-process restart preserves one readable legacy confirmed Effect without producing an Artifact', 'negative')
  check('fresh-process restart preserves the legacy waiting Effect as abandoned and retry-authorized')
  check('fresh-process restart keeps the pre-Acceptance Artifact out of downstream handoff', 'negative')
  check('fresh-process restart keeps legacy Office output bindings out of downstream handoff', 'negative')
}

async function verifyFailureBoundaries(input) {
  const {
    deliveries,
    fixture,
    lifecycleApi,
    producerApi,
    snapshotApi,
    officeApi,
    officeCheckApi
  } = input
  const document = deliveries.find((item) => item.specification.kind === 'document')
  assert(document, 'document delivery is required for failure tests')
  const original = readFileSync(document.generated.path)

  await assertRejects(
    () => officeApi.executeOfficeArtifactTool(
      document.specification.toolName,
      document.specification.input,
      workspaceRoot,
      document.handle.target
    ),
    /EEXIST|exist|已存在|覆盖/i,
    'repeating a confirmed Office execution must not overwrite its Artifact'
  )
  assertBufferEqual(readFileSync(document.generated.path), original, 'confirmed Office Artifact after duplicate execution')
  check('duplicate execution fails closed without changing the confirmed Artifact', 'negative')

  const wrongDigest = await officeCheckApi.runOfficeSelfCheck({
    workspacePath: document.generated.path,
    expectedSha256: `sha256:${'0'.repeat(64)}`,
    artifactKind: 'document',
    mediaType: document.specification.mediaType,
    sourceRefs: document.handle.target.sourceRefs,
    sourceSnapshots: document.handle.target.sourceSnapshots,
    runtimeTraceable: true
  })
  assertEqual(wrongDigest.ok, false, 'wrong digest self-check')
  assertEqual(wrongDigest.digestMatch, false, 'wrong digest match flag')
  check('declared digest mismatch fails the Office self-check', 'negative')

  writeFileSync(document.generated.path, Buffer.from('corrupt Office bytes\n'))
  const corrupt = await officeCheckApi.runOfficeSelfCheck({
    workspacePath: document.generated.path,
    expectedSha256: document.lifecycle.digest,
    artifactKind: 'document',
    mediaType: document.specification.mediaType,
    sourceRefs: document.handle.target.sourceRefs,
    sourceSnapshots: document.handle.target.sourceSnapshots,
    runtimeTraceable: true
  })
  assertEqual(corrupt.ok, false, 'corrupt Office self-check')
  await assertRejects(
    () => lifecycleApi.verifyPersistedArtifactLifecycle(userData),
    /digest mismatch|摘要|digest|artifact bytes|invalid|字节/i,
    'physical Office Artifact corruption must fail lifecycle verification'
  )
  writeFileSync(document.generated.path, original)
  await lifecycleApi.verifyPersistedArtifactLifecycle(userData)
  check('physical Office corruption fails closed and restored bytes verify again', 'negative')

  await assertRejects(
    () => lifecycleApi.registerPersistedArtifactLifecycle({
      id: 'artifact:office:cross-project',
      projectId: fixture.foreignProjectId,
      goalId: fixture.goalId,
      workItemId: fixture.workItemId,
      runId: fixture.run.id,
      lineageId: 'lineage:office:cross-project',
      kind: 'document',
      title: 'Cross project Office artifact',
      version: 1,
      provenance: 'explicit',
      mediaType: document.specification.mediaType,
      retention: { mode: 'retain' },
      content: {
        storageKind: 'source_ref',
        sourceRef: document.generated.path,
        expectedDigest: document.lifecycle.digest
      },
      metadata: { gate: 'office-delivery' },
      createdAt: Date.now()
    }, userData),
    /Project|project|ownership|boundary/i,
    'Office Artifact must not cross the canonical Project boundary'
  )
  check('cross-Project Office Artifact registration is rejected', 'negative')

  const persisted = await snapshotApi.getTaskSnapshot(fixture.run.sessionId, userData)
  assert(persisted?.run, 'forged producer fixture must read canonical Run')
  const forgedEffect = {
    ...document.effect,
    id: 'effect-office-forged-confirmed',
    toolUseId: 'office-forged-confirmed'
  }
  await assertRejects(
    () => producerApi.registerConfirmedRunArtifactLifecycles({
      ...persisted.run,
      effects: [forgedEffect, ...(persisted.run.effects ?? [])]
    }, userData),
    /canonical|persisted|Effect|Run/i,
    'producer must reject a caller-forged confirmed Effect'
  )
  assertEqual(
    await lifecycleApi.getPersistedArtifactLifecycle(
      'artifact:office:effect-office-forged-confirmed',
      userData
    ),
    null,
    'forged Effect Artifact write'
  )
  check('producer rejects caller-forged confirmed Effect with zero Artifact write', 'negative')
}

async function seedCanonicalRun(workspaceApi, workspaceCommands, snapshotApi) {
  const projectId = 'project-office'
  const foreignProjectId = 'project-foreign'
  const goalId = 'goal-office'
  const workItemId = 'work-item-office-delivery'
  const runId = 'run-office'
  const sourceDir = path.join(workspaceRoot, 'inputs')
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(path.join(sourceDir, 'source.md'), '# Source\nVerified Office delivery source.\n', 'utf8')
  writeFileSync(path.join(sourceDir, 'failure-source.md'), '# Failure source\nStable before approval.\n', 'utf8')

  const store = new workspaceApi.ProjectWorkspaceStore(userData)
  await store.open()
  await store.createWorkspace({ id: projectId, name: 'Office Project', kind: 'office', resources: [] })
  await store.createWorkspace({ id: foreignProjectId, name: 'Foreign Project', kind: 'office', resources: [] })
  const commands = workspaceCommands.createProjectWorkspaceCommandService(store, { rootDir: userData })
  await commands.reconcileShadowProjection()
  await commands.createGoal({
    id: goalId,
    projectId,
    title: 'Produce verified Office deliverables',
    objective: 'Generate Word, Excel, PowerPoint, and PDF through the canonical delivery chain',
    status: 'verifying',
    acceptance: [{
      id: 'goal-office-delivery',
      criterion: 'The Office deliverables are generated through the canonical delivery chain.',
      required: true
    }]
  })
  let workItem = await commands.createWorkItem({
    id: workItemId,
    projectId,
    goalId,
    title: 'Generate Office deliverables',
    type: 'delivery',
    status: 'verifying',
    acceptanceSpec: [{
      id: 'goal-office-delivery',
      criterion: 'The Office deliverables are generated through the canonical delivery chain.',
      required: true
    }]
  })
  const run = {
    schemaVersion: 1,
    id: runId,
    sessionId: 'session-office',
    taskId: 'task-office',
    status: 'executing',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 1_000,
    updatedAt: 1_001,
    steps: [],
    toolExecutions: [],
    effects: []
  }
  const snapshot = snapshotApi.buildTaskSnapshot({
    meta: {
      id: run.sessionId,
      title: 'Office delivery required gate',
      cwd: workspaceRoot,
      projectId,
      workspaceId: projectId,
      goalId,
      workItemId,
      childTaskId: run.taskId,
      model: 'synthetic-office-model',
      providerId: 'synthetic-office-provider',
      permissionMode: 'default',
      status: 'running',
      sdkSessionId: 'sdk-office-required',
      costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      contextTokens: 0,
      createdAt: run.createdAt
    },
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'created',
    run,
    now: run.updatedAt
  })
  const persisted = await snapshotApi.saveTaskSnapshot(snapshot, userData)
  const current = await store.getWorkItem(workItem.id)
  assert(current, 'Office WorkItem must persist')
  if (!current.runRefs.includes(runId)) {
    workItem = await commands.updateWorkItem(current.id, {
      runRefs: [...current.runRefs, runId]
    }, { expectedRevision: current.revision })
  } else {
    workItem = current
  }
  return {
    projectId,
    foreignProjectId,
    goalId,
    workItemId,
    workItem,
    runId,
    run: persisted.run ?? run
  }
}

function officeSpecifications() {
  return [
    {
      kind: 'document',
      toolName: 'create_document',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      input: {
        path: 'deliverables/caogen-brief.docx',
        title: 'EastGenesis Office Delivery',
        headings: ['Verified output'],
        paragraphs: ['This Word document was produced through a confirmed EastGenesis Effect.'],
        source_refs: ['inputs/source.md']
      }
    },
    {
      kind: 'spreadsheet',
      toolName: 'create_spreadsheet',
      mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      input: {
        path: 'deliverables/caogen-metrics.xlsx',
        title: 'EastGenesis Metrics',
        sheets: [{
          name: 'Metrics',
          rows: [
            ['Metric', 'Value'],
            ['Confirmed Effects', 4],
            ['Calculated total', { formula: 'SUM(B2:B2)', result: 4 }]
          ]
        }],
        source_refs: ['inputs/source.md']
      }
    },
    {
      kind: 'presentation',
      toolName: 'create_presentation',
      mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      input: {
        path: 'deliverables/caogen-overview.pptx',
        title: 'EastGenesis Overview',
        slides: [{
          title: 'Verified Agent Work OS',
          body: 'A vendor-neutral delivery chain.',
          bullets: ['Effect confirmation', 'Artifact provenance', 'Acceptance evidence']
        }],
        source_refs: ['inputs/source.md']
      }
    },
    {
      kind: 'pdf',
      toolName: 'create_pdf',
      mediaType: 'application/pdf',
      input: {
        path: 'deliverables/caogen-summary.pdf',
        title: 'EastGenesis 可验证交付',
        sections: [{
          heading: '运行来源',
          paragraphs: ['该 PDF 使用当前 canonical Run 与 Effect 作为来源链，不依赖外部 source_refs。']
        }]
      }
    }
  ]
}

function verifyCrossTimezoneDeterminism() {
  const payload = Buffer.from(JSON.stringify({ outDir, userData, workspaceRoot })).toString('base64url')
  const zones = ['UTC', 'Asia/Shanghai', 'America/Los_Angeles']
  const observations = zones.map((timezone) => JSON.parse(execFileSync(
    process.execPath,
    [path.resolve(process.argv[1]), '--timezone-probe', payload],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, TZ: timezone }
    }
  )))
  const baseline = JSON.stringify(observations[0])
  for (let index = 1; index < observations.length; index += 1) {
    assertEqual(JSON.stringify(observations[index]), baseline, `Office output identity in ${zones[index]}`)
  }
}

async function runTimezoneProbe(payload) {
  process.env.CAOGEN_USER_DATA = payload.userData
  const officeApi = await importCompiledFrom(payload.outDir, 'main/agent/tools/office-artifact.js')
  const identities = {}
  const extensions = { document: 'docx', spreadsheet: 'xlsx', presentation: 'pptx', pdf: 'pdf' }
  for (const specification of officeSpecifications()) {
    const input = {
      ...specification.input,
      path: `timezone-probe/${specification.kind}.${extensions[specification.kind]}`
    }
    delete input.source_refs
    const target = await officeApi.buildOfficeArtifactEffectTarget(
      specification.toolName,
      input,
      payload.workspaceRoot
    )
    identities[specification.kind] = {
      sha256: target.expectedSha256,
      bytes: target.expectedBytes
    }
  }
  process.stdout.write(JSON.stringify(identities))
}

async function verifyFormatCanBeParsed(specification, filePath) {
  const bytes = readFileSync(filePath)
  if (specification.kind === 'spreadsheet') {
    const ExcelJS = require('exceljs')
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(bytes)
    const sheet = workbook.getWorksheet('Metrics')
    assert(sheet, 'generated XLSX must expose the Metrics worksheet')
    assertEqual(sheet.getCell('B2').value, 4, 'generated XLSX scalar cell')
    assert((sheet.getColumn(1).width ?? 0) >= 'Confirmed Effects'.length + 2,
      'generated XLSX label column must not clip its longest value')
    assertEqual(sheet.views[0]?.state, 'frozen', 'generated XLSX frozen header row')
    assertEqual(sheet.views[0]?.ySplit, 1, 'generated XLSX frozen row count')
    assertEqual(sheet.views[0]?.showGridLines, false, 'generated XLSX explicit visual structure')
    assert(sheet.headerFooter.oddHeader.includes('EastGenesis Metrics'), 'generated XLSX printable title')
    assertEqual(sheet.getRow(1).font.bold, true, 'generated XLSX header emphasis')
    const formula = sheet.getCell('B3').value
    assert(formula && typeof formula === 'object' && formula.formula === 'SUM(B2:B2)', 'generated XLSX formula')
    return
  }
  if (specification.kind === 'pdf') {
    assert(bytes.subarray(0, 5).toString('ascii') === '%PDF-', 'generated PDF header')
    assert(bytes.subarray(-1_024).includes(Buffer.from('%%EOF')), 'generated PDF trailer')
    assert(bytes.includes(Buffer.from('/FontFile2')), 'generated PDF must embed its Chinese TrueType font')
    return
  }
  const JSZip = require('jszip')
  const archive = await JSZip.loadAsync(bytes, { checkCRC32: true })
  const requiredPart = specification.kind === 'document'
    ? 'word/document.xml'
    : 'ppt/presentation.xml'
  const part = archive.file(requiredPart)
  assert(part, `generated ${specification.kind} must contain ${requiredPart}`)
  const xml = await part.async('string')
  assert(xml.includes(specification.kind === 'document' ? 'EastGenesis Office Delivery' : 'presentation'),
    `generated ${specification.kind} primary OOXML part must be readable`)
  if (specification.kind === 'presentation') {
    const slide = archive.file('ppt/slides/slide1.xml')
    assert(slide, 'generated PPTX must contain slide1.xml')
    const slideXml = await slide.async('string')
    assert(slideXml.includes('Verified Agent Work OS'), 'generated PPTX slide text')
    assert(slideXml.includes('sz="3500"'), 'generated PPTX title must meet the 35pt readability floor')
  }
}

async function runRestartProbe(payload) {
  process.env.CAOGEN_USER_DATA = payload.userData
  const snapshotApi = await importCompiledFrom(payload.outDir, 'main/task/task-snapshot.js')
  const effectRuntime = await importCompiledFrom(payload.outDir, 'main/task/effect-runtime.js')
  const lifecycleApi = await importCompiledFrom(payload.outDir, 'main/task/artifact-lifecycle-api.js')
  const workflowApi = await importCompiledFrom(payload.outDir, 'main/task/workflow-ledger-api.js')
  const handoffApi = await importCompiledFrom(payload.outDir, 'main/task/workflow-stage-handoff.js')
  const workspaceApi = await importCompiledFrom(payload.outDir, 'main/project-workspace/index.js')
  const persisted = await snapshotApi.getTaskSnapshot(payload.sessionId, payload.userData)
  assert(persisted?.run, 'restart probe cannot read persisted TaskSnapshot Run')
  const recovered = await effectRuntime.reconcilePersistedTaskSnapshot(persisted)
  assert(recovered.run, 'restart probe cannot reconcile persisted TaskSnapshot Run')
  const lifecycle = await lifecycleApi.verifyPersistedArtifactLifecycle(payload.userData)
  const ledger = await workflowApi.listPersistedWorkflowLedger({
    projectId: payload.projectId,
    limit: 500
  }, payload.userData)
  const store = new workspaceApi.ProjectWorkspaceStore(payload.userData)
  await store.open()
  const workItem = await store.getWorkItem(payload.workItemId)
  assert(workItem, 'restart probe cannot reopen producing WorkItem')
  const downstreamHandoff = await handoffApi.resolveWorkflowStageHandoff({
    projectId: payload.projectId,
    workItemId: payload.downstreamWorkItemId,
    rootDir: payload.userData
  })
  const passedArtifactIds = new Set(payload.passedArtifactIds)
  const passedAcceptanceIds = new Set(payload.passedAcceptanceIds)
  const confirmedOfficeEffects = recovered.run.effects.filter(
    (effect) => effect.status === 'confirmed' && effect.target.kind === 'office_artifact'
  )
  const outputBoundConfirmedOfficeEffects = confirmedOfficeEffects.filter((effect) =>
    effect.target.outputBindingVersion === 1 &&
    Array.isArray(effect.target.sourceSnapshots) &&
    typeof effect.target.expectedSha256 === 'string' &&
    Number.isSafeInteger(effect.target.expectedBytes)
  )
  const legacyConfirmedArtifact = await lifecycleApi.getPersistedArtifactLifecycle(
    payload.legacyConfirmedArtifactId,
    payload.userData
  )
  process.stdout.write(JSON.stringify({
    confirmedOfficeEffects: confirmedOfficeEffects.length,
    outputBoundConfirmedOfficeEffects: outputBoundConfirmedOfficeEffects.length,
    quarantinedLegacyOfficeEffects: confirmedOfficeEffects.length - outputBoundConfirmedOfficeEffects.length,
    legacyConfirmedEffectReadable: confirmedOfficeEffects.some(
      (effect) => effect.id === payload.legacyConfirmedEffectId
    ),
    legacyConfirmedArtifactPresent: legacyConfirmedArtifact !== null,
    legacyWaitingEffectStatus: recovered.run.effects.find(
      (effect) => effect.id === payload.legacyWaitingEffectId
    )?.status,
    lifecycleArtifacts: lifecycle.artifacts,
    ledgerOfficeArtifacts: ledger.artifacts.items.filter(
      (artifact) => passedArtifactIds.has(artifact.id) || artifact.id === payload.failedArtifactId
    ).length,
    passedAcceptanceCount: ledger.acceptances.items.filter(
      (acceptance) => passedAcceptanceIds.has(acceptance.id) && acceptance.status === 'passed'
    ).length,
    failedAcceptanceStatus: ledger.acceptances.items.find(
      (acceptance) => acceptance.id === payload.failedAcceptanceId
    )?.status,
    passedArtifactRefCount: workItem.artifactRefs.filter((id) => passedArtifactIds.has(id)).length,
    failedArtifactAttached: workItem.artifactRefs.includes(payload.failedArtifactId),
    unacceptedArtifactHandedOff: downstreamHandoff.artifacts.some(
      (item) => item.artifact.id === payload.unacceptedArtifactId
    ),
    legacyArtifactHandedOff: downstreamHandoff.artifacts.some(
      (item) => item.artifact.id === payload.legacyArtifactId
    )
  }))
}

function compileSources() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/agent/tools/office-artifact.ts',
    'src/main/task/effect-runtime.ts',
    'src/main/project-workspace/index.ts',
    'src/main/project-workspace/command-service.ts',
    'src/main/task/task-snapshot.ts',
    'src/main/task/artifact-lifecycle-api.ts',
    'src/main/task/workflow-ledger-api.ts',
    'src/main/task/workflow-stage-handoff.ts',
    '--outDir', outDir,
    '--target', 'ES2023',
    '--module', 'CommonJS',
    '--moduleResolution', 'Node',
    '--lib', 'ES2023',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop',
    '--resolveJsonModule',
    '--strict'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub() {
  const electronDir = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(path.join(electronDir, 'index.js'), `module.exports = { app: { getPath: () => ${JSON.stringify(userData)} } }\n`)
  writeFileSync(path.join(electronDir, 'package.json'), '{"type":"commonjs"}\n')
}

async function importCompiled(suffix) {
  return importCompiledFrom(outDir, suffix)
}

async function importCompiledFrom(root, suffix) {
  const file = findCompiled(root, suffix)
  if (!file) throw new Error(`compiled module not found: ${suffix}`)
  return import(pathToFileURL(file).href)
}

function findCompiled(root, suffix) {
  const target = suffix.split('/').join(path.sep)
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of require('node:fs').readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(fullPath)
      else if (entry.isFile() && fullPath.endsWith(target)) return fullPath
    }
  }
  return null
}

function gitOutput(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function check(name, kind = 'positive') {
  report.checks.push({ name, kind, status: 'passed' })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assertBufferEqual(actual, expected, message) {
  if (!actual.equals(expected)) throw new Error(`${message}: bytes changed`)
}

async function assertRejects(task, pattern, message) {
  try {
    await task()
  } catch (error) {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    if (!pattern.test(text)) throw new Error(`${message}: unexpected error: ${text}`)
    return
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}
