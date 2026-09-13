/** Main-created opaque identity copied into a frozen Run; it contains no endpoint or credential material. */
export interface ProviderConnectionIdentity { generationId: string; revision: number }

/** Stored only on the main-owned Provider record. Neither field is accepted from ProviderInput. */
export interface ProviderConnectionBinding {
  connectionIdentity?: ProviderConnectionIdentity
  /** Desired OAuth pool membership/policy digest. A mismatch with the authoritative account store blocks execution. */
  connectionAuthorizationPoolDigest?: string
}
