/** Host execution ownership is separate from Project/Goal/WorkItem ownership. */
export interface TaskHandoffIdentity { sessionId: string; sessionCreatedAt: number }
export interface TaskHandoffHostIdentity { hostId: string; publicKey: string }
export interface TaskHandoffReleaseProof {
  schemaVersion: 1
  identity: TaskHandoffIdentity
  fromHostId: string
  toHostId: string
  fromGeneration: number
  toGeneration: number
  handoffId: string
  bundleDigest: string
  sourcePublicKey: string
  issuedAt: number
  signature: string
}
export interface TaskHostOwnershipRecord {
  schemaVersion: 1
  identity: TaskHandoffIdentity
  ownerHostId: string
  generation: number
  state: 'owned' | 'preparing' | 'released'
  handoffId?: string
  targetHostId?: string
  /** Imported records remain preparing until their bytes and ledger are verified. */
  incoming?: boolean
  releaseProof?: TaskHandoffReleaseProof
  updatedAt: number
}
export interface TaskHostExecutionSubject { sessionId: string; sessionCreatedAt?: number }
export interface TaskHostExecutionClaim extends TaskHostExecutionSubject { generation: number }
