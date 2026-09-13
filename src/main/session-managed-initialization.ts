import type { SessionMeta } from '../shared/types'
import type { Engine } from './engine'
import type { ManagedSessionCreationOptions } from './session-manager-support'

/** Awaited creation keeps its journal until initialization is durably observable.
 * Default callers retain the existing fire-and-observe engine startup behavior. */
export async function completeManagedSessionInitialization(options: {
  meta: SessionMeta
  session?: Engine
  lifecycle: ManagedSessionCreationOptions
  rollbackBeforeStart: () => Promise<void>
  persistInitialized: () => Promise<void>
  acknowledge: () => void
}): Promise<SessionMeta> {
  const { meta, session, lifecycle } = options
  try { await lifecycle.beforeStart?.(meta) } catch (error) {
    await options.rollbackBeforeStart()
    throw error
  }
  const start = session?.start()
  if (!lifecycle.awaitStart) return meta
  await start
  await options.persistInitialized()
  options.acknowledge()
  return { ...(session?.meta ?? meta) }
}
