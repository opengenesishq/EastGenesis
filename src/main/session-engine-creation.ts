import { app } from 'electron'
import { createEngine, type EngineEmit } from './engine'
import { sessionMetaForPlacement, type SessionCreationDraft, type SessionWorktreePlacement } from './session-create-lifecycle'
import { resolveDigitalWorkerSessionScope } from './digital-worker/session-binding'
import { transcriptForkSeedEntries } from './transcript'

/** Owns factory construction after placement; activation and persistence stay in the manager. */
export function preparePlacedSessionEngine(draft: SessionCreationDraft, worktree: SessionWorktreePlacement, emit: EngineEmit) {
  const meta = sessionMetaForPlacement(draft, worktree)
  resolveDigitalWorkerSessionScope(meta, app.getPath('userData'))
  const initialSeq = meta.conversationForkSourceSdkSessionId
    ? transcriptForkSeedEntries(meta.conversationForkSourceSdkSessionId, meta.conversationForkCheckpointId)
      .reduce((max, entry) => Math.max(max, entry.seq), 0)
    : 0
  const session = createEngine(meta.engine, meta, emit, draft.opts.resumeSdkSessionId, initialSeq)
  return { meta, session }
}
