import {
  ProjectImportRecoveryPendingError,
  startProjectImportRecoveryReadiness,
  type ProjectImportRecoveryResult
} from '../data-lifecycle/project-import-coordinator'

const observedReadiness = new WeakSet<Promise<ProjectImportRecoveryResult>>()

export function projectImportReadiness(userDataRoot: string): Promise<ProjectImportRecoveryResult> {
  const readiness = startProjectImportRecoveryReadiness(userDataRoot)
  if (observedReadiness.has(readiness)) return readiness
  observedReadiness.add(readiness)
  void readiness.then(({ recovered }) => {
    if (recovered.length > 0) {
      console.info(
        `[caogen] Project import recovery completed: count=${recovered.length}; projects=${projectIds(recovered)}`
      )
    }
  }, (error: unknown) => {
    if (error instanceof ProjectImportRecoveryPendingError) {
      console.error(
        `[caogen] Project import recovery blocked: count=${error.failures.length}; projects=${projectIds(error.failures)}`
      )
      return
    }
    console.error(`[caogen] Project import recovery unavailable: ${error instanceof Error ? error.message : String(error)}`)
  })
  return readiness
}

function projectIds(values: readonly { projectId: string }[]): string {
  return [...new Set(values.map((value) => value.projectId))].sort().join(',')
}
