import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { taskSnapshotsDbFile, withTaskSnapshotDatabaseMutationBarrier } from './task-snapshot'
import { assessWorkflowLedgerCanonicalReadiness, openWorkflowLedgerDatabase, readWorkflowLedgerStoreVersionStrict } from './workflow-ledger-readiness'
import { readRegularFile } from './workflow-ledger-migration-storage'

/**
 * Read-only repair ingress for an already-current store whose old Acceptance
 * may reference externally edited files. This does not cache readiness, open
 * legacy stores, persist a DB, or relax any normal task-store read gate.
 * The caller must verify the full original Ledger after observing the exact
 * files and defer only those Artifact file reads before a canonical commit.
 */
export async function readWorkflowFileChangeRepairDatabase<T>(
  rootDir: string,
  reader: (db: WorkflowLedgerDatabase) => T | Promise<T>
): Promise<T> {
  return withTaskSnapshotDatabaseMutationBarrier(rootDir, async () => {
    const databasePath = taskSnapshotsDbFile(rootDir)
    const bytes = await readRegularFile(databasePath, 'file-change repair database')
    const db = await openWorkflowLedgerDatabase(bytes)
    try {
      if (readWorkflowLedgerStoreVersionStrict(db) !== 9) {
        throw new Error('STUDIO_FILE_CHECK_STORE_VERSION: file repair requires the current canonical store')
      }
      const readiness = assessWorkflowLedgerCanonicalReadiness(db, {
        sourceKind: 'sqlite', sourcePath: databasePath, sourceBytes: bytes
      })
      // This diagnostic is not an exemption: it is rechecked by the caller's
      // complete original-Ledger validation with the observed file IDs only.
      if (readiness.diagnostics.some(diagnostic => diagnostic.code !== 'workflow_verification_failed')) {
        throw new Error('STUDIO_FILE_CHECK_STORE_INTEGRITY: unrelated store damage requires repair')
      }
      return await reader(db)
    } finally { db.close() }
  })
}
