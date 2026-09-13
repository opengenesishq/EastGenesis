import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const serviceWorkerActions = {
  contend_writer_until_created: runContendedWriterAction,
  prime_rollback: runPrimeRollbackAction,
  crash: runCrashAction,
  reconcile: runReconcileAction,
  same_process_convergence: runSameProcessConvergenceAction,
  pending_writer_matrix: runPendingWriterMatrixAction,
  tamper_during_operation: runTamperDuringOperationAction,
  attempt_mutation: runAttemptMutationAction
}

export async function runProviderProfileRestartServiceWorker(action, dependencies) {
  const handler = serviceWorkerActions[action]
  if (!handler) throw new Error(`Unknown Provider Profile restart worker action: ${action}`)
  const context = await createWorkerContext(dependencies)
  await handler(context)
}

async function createWorkerContext(dependencies) {
  const compiledServicePath = dependencies.requiredEnvironment(
    'CAOGEN_PROVIDER_PROFILE_RESTART_SERVICE'
  )
  const service = await import(pathToFileURL(compiledServicePath).href)
  return { ...dependencies, service }
}

async function runContendedWriterAction(context) {
  const providers = await loadProviders(context.requiredEnvironment)
  const deadline = Date.now() + 10_000
  const observedCodes = new Set()
  for (let attempts = 1; Date.now() < deadline; attempts += 1) {
    try {
      providers.createProvider({
        name: 'Contended Provider writer',
        baseUrl: 'http://127.0.0.1:11435/v1',
        models: ['contended-writer-model'],
        authMode: 'none',
        engine: 'openai',
        openaiProtocol: 'chat'
      })
      writeResult({ acquired: true, attempts, observedCodes: [...observedCodes] })
      return
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code !== 'LOCK_HELD') throw error
      observedCodes.add(code)
      context.markLockContentionObserved()
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)
    }
  }
  throw new Error('Graceful Provider Store writer contender timed out')
}

function runPrimeRollbackAction({ requiredEnvironment, service }) {
  const preview = service.previewProviderProfileFile(
    requiredEnvironment('CAOGEN_PROVIDER_PROFILE_RESTART_IMPORT')
  )
  const applied = service.applyProviderProfilePreview(preview.previewId, [])
  writeResult({ backupId: applied.backup.id })
}

function runCrashAction({ requiredEnvironment, service }) {
  const checkpoint = requiredEnvironment('CAOGEN_PROVIDER_PROFILE_RESTART_CHECKPOINT')
  const options = {
    faultAt: checkpoint,
    onFault: () => process.kill(process.pid, 'SIGKILL')
  }
  if (requiredEnvironment('CAOGEN_PROVIDER_PROFILE_RESTART_OPERATION') === 'rollback') {
    service.rollbackProviderProfileBackup(
      requiredEnvironment('CAOGEN_PROVIDER_PROFILE_RESTART_BACKUP_ID'),
      options
    )
  } else {
    const preview = service.previewProviderProfileFile(
      requiredEnvironment('CAOGEN_PROVIDER_PROFILE_RESTART_IMPORT')
    )
    service.applyProviderProfilePreview(preview.previewId, [], options)
  }
  throw new Error('Provider Profile crash checkpoint returned without terminating the worker')
}

function runReconcileAction({ service, userDataDir }) {
  const reconciliations = service.reconcileProviderProfileOperations()
  writeResult({ reconciliations, userDataDir })
}

async function runSameProcessConvergenceAction(context) {
  const { requiredEnvironment, seedProvider, service, userDataDir } = context
  const providers = await loadProviders(requiredEnvironment)
  const importPath = requiredEnvironment('CAOGEN_PROVIDER_PROFILE_RESTART_IMPORT')
  const preview = service.previewProviderProfileFile(importPath)
  const initialModel = providers.listProviders()[0]?.models?.[0]
  const storePath = path.join(userDataDir, 'providers.json')
  // Startup can migrate the seed to include a durable connection identity. A
  // reconciliation repair must restore that exact frozen snapshot, not rebuild
  // a legacy record that represents a different Provider generation.
  const storeBeforeOperation = readFileSync(storePath, 'utf8')
  let operationBlocked = false
  try {
    service.applyProviderProfilePreview(preview.previewId, [], {
      onCheckpoint: (checkpoint) => {
        if (checkpoint !== 'after_store_commit') return
        const thirdStore = JSON.parse(storeBeforeOperation)
        currentProviderStoreEntries(thirdStore).find(
          (provider) => provider.id === seedProvider().id
        ).models = ['third-digest-model']
        writeFileSync(storePath, `${JSON.stringify(thirdStore, null, 2)}\n`, { mode: 0o600 })
      }
    })
  } catch {
    operationBlocked = true
  }
  const journalPath = path.join(userDataDir, 'provider-profile-operations', 'journal.json')
  const waitingPhase = JSON.parse(readFileSync(journalPath, 'utf8')).entries.find(
    (entry) => entry.phase === 'waiting_reconciliation'
  )?.phase
  const pendingMutationCode = capturePendingMutationCode(providers)
  writeFileSync(storePath, storeBeforeOperation, { mode: 0o600 })
  const reconciliations = service.reconcileProviderProfileOperations()
  const repairedStoreByteStable = readFileSync(storePath, 'utf8') === storeBeforeOperation
  providers.createProvider({
    name: 'Same-process resumed mutation',
    baseUrl: 'http://127.0.0.1:11436/v1',
    models: ['same-process-resumed'],
    authMode: 'none',
    engine: 'openai',
    openaiProtocol: 'chat'
  })
  const finalProviders = currentProviderStoreEntries(JSON.parse(readFileSync(storePath, 'utf8')))
  writeResult({
    initialModel,
    operationBlocked,
    waitingPhase,
    pendingMutationCode,
    reconciliations,
    repairedStoreByteStable,
    created: finalProviders.some((provider) => provider.name === 'Same-process resumed mutation'),
    finalModels: finalProviders
      .filter((provider) => provider.id === seedProvider().id)
      .flatMap((provider) => provider.models)
  })
}

function capturePendingMutationCode(providers) {
  try {
    providers.createProvider({
      name: 'Must remain blocked in same process',
      baseUrl: 'http://127.0.0.1:11437/v1',
      models: ['must-remain-blocked'],
      authMode: 'none',
      engine: 'openai',
      openaiProtocol: 'chat'
    })
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error ? error.code : undefined
  }
  return undefined
}

function currentProviderStoreEntries(document) {
  if (document?.schemaVersion !== 1 || document?.format !== 'caogen.provider-store.v1' ||
      !Array.isArray(document?.entries)) {
    throw new Error('Provider Store did not converge to the current schema')
  }
  return document.entries
}

async function runPendingWriterMatrixAction(context) {
  const { requiredEnvironment, seedProvider, service, userDataDir } = context
  const providers = await loadProviders(requiredEnvironment)
  const importPath = requiredEnvironment('CAOGEN_PROVIDER_PROFILE_RESTART_IMPORT')
  const preview = service.previewProviderProfileFile(importPath)
  const storePath = path.join(userDataDir, 'providers.json')
  const storeBefore = readFileSync(storePath, 'utf8')
  const writerResults = {}
  try {
    service.applyProviderProfilePreview(preview.previewId, [], {
      onCheckpoint: (checkpoint, operationId) => {
        if (checkpoint !== 'after_prepare') return
        capturePendingWriterMatrix({
          operationId,
          providers,
          seedProvider,
          userDataDir,
          writerResults
        })
        throw new Error('stop after prepared pending writer matrix')
      }
    })
  } catch {
    // The injected stop reconciles the untouched before snapshot to aborted.
  }
  const journalPath = path.join(userDataDir, 'provider-profile-operations', 'journal.json')
  const finalPhase = JSON.parse(readFileSync(journalPath, 'utf8')).entries.at(-1)?.phase
  writeResult({
    writerResults,
    storeByteStable: readFileSync(storePath, 'utf8') === storeBefore,
    finalPhase
  })
}

function capturePendingWriterMatrix(context) {
  const { operationId, providers, seedProvider, userDataDir, writerResults } = context
  const journalPath = path.join(userDataDir, 'provider-profile-operations', 'journal.json')
  const entry = JSON.parse(readFileSync(journalPath, 'utf8')).entries.find(
    (candidate) => candidate.operationId === operationId
  )
  const arbitraryProviders = [{ ...seedProvider(), models: ['forged-third-digest'] }]
  writerResults.create = captureWorkerMutation(() => providers.createProvider({
    name: 'Blocked prepared create',
    baseUrl: 'http://127.0.0.1:11438/v1',
    models: ['blocked-create'],
    authMode: 'none',
    engine: 'openai',
    openaiProtocol: 'chat'
  }))
  writerResults.update = captureWorkerMutation(() =>
    providers.updateProvider(seedProvider().id, { models: ['blocked-update'] }))
  writerResults.delete = captureWorkerMutation(() => providers.deleteProvider(seedProvider().id))
  writerResults.directCommit = captureWorkerMutation(() =>
    providers.commitProviderProfileStore(arbitraryProviders))
  writerResults.forgedOperationWithoutDigest = captureWorkerMutation(() =>
    providers.commitProviderProfileStore(arbitraryProviders, { operationId }))
  writerResults.forgedOperationWrongResult = captureWorkerMutation(() =>
    providers.commitProviderProfileStore(arbitraryProviders, {
      operationId,
      expectedWriteDigest: entry.desiredSnapshotDigest
    }))
}

function runTamperDuringOperationAction(context) {
  const { requiredEnvironment, service, userDataDir } = context
  const importPath = requiredEnvironment('CAOGEN_PROVIDER_PROFILE_RESTART_IMPORT')
  const originalBackupPath = requiredEnvironment('CAOGEN_PROVIDER_PROFILE_RESTART_ORIGINAL_BACKUP')
  const tamperCheckpoint = requiredEnvironment('CAOGEN_PROVIDER_PROFILE_RESTART_TAMPER_CHECKPOINT')
  const preview = service.previewProviderProfileFile(importPath)
  const storeBeforeOperationDigest = createHash('sha256')
    .update(readFileSync(path.join(userDataDir, 'providers.json'))).digest('hex')
  const outcome = { blocked: false, operationId: undefined, safetyBackupId: undefined }
  try {
    service.applyProviderProfilePreview(preview.previewId, [], {
      onCheckpoint: (checkpoint, currentOperationId) => {
        if (checkpoint !== tamperCheckpoint) return
        tamperSafetyBackup({ currentOperationId, originalBackupPath, outcome, userDataDir })
      }
    })
  } catch {
    outcome.blocked = true
  }
  const journalPath = path.join(userDataDir, 'provider-profile-operations', 'journal.json')
  const phase = JSON.parse(readFileSync(journalPath, 'utf8')).entries.find(
    (entry) => entry.operationId === outcome.operationId
  )?.phase
  writeResult({ ...outcome, phase, storeBeforeOperationDigest })
}

function tamperSafetyBackup(context) {
  const { currentOperationId, originalBackupPath, outcome, userDataDir } = context
  outcome.operationId = currentOperationId
  const journalPath = path.join(userDataDir, 'provider-profile-operations', 'journal.json')
  const entry = JSON.parse(readFileSync(journalPath, 'utf8')).entries.find(
    (candidate) => candidate.operationId === currentOperationId
  )
  outcome.safetyBackupId = entry?.safetyBackupId
  const backupPath = path.join(
    userDataDir,
    'provider-profile-backups',
    `${outcome.safetyBackupId}.json`
  )
  const original = readFileSync(backupPath)
  writeFileSync(originalBackupPath, original, { mode: 0o600 })
  const document = JSON.parse(original.toString('utf8'))
  document.providers[0].models = ['inflight-substituted-backup']
  const { payloadDigest: _previousDigest, ...payload } = document
  document.payloadDigest = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  writeFileSync(backupPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
}

async function runAttemptMutationAction({ requiredEnvironment }) {
  const providers = await loadProviders(requiredEnvironment)
  try {
    providers.createProvider({
      name: 'Blocked while Provider Profile is pending',
      baseUrl: 'http://127.0.0.1:11435/v1',
      models: ['must-not-persist'],
      authMode: 'none',
      engine: 'openai',
      openaiProtocol: 'chat'
    })
    writeResult({ blocked: false })
  } catch (error) {
    writeResult({
      blocked: true,
      name: error instanceof Error ? error.name : 'Error',
      code: error && typeof error === 'object' && typeof error.code === 'string'
        ? error.code
        : undefined
    })
  }
}

async function loadProviders(requiredEnvironment) {
  return import(pathToFileURL(
    requiredEnvironment('CAOGEN_PROVIDER_PROFILE_RESTART_PROVIDERS')
  ).href)
}

function captureWorkerMutation(action) {
  try {
    action()
    return { blocked: false }
  } catch (error) {
    return {
      blocked: true,
      name: error instanceof Error ? error.name : 'Error',
      code: error && typeof error === 'object' && 'code' in error ? error.code : undefined
    }
  }
}

function writeResult(result) {
  process.stdout.write(JSON.stringify(result))
}
