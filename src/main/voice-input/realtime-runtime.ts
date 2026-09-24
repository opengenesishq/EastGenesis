import { app } from 'electron'
import { join } from 'node:path'
import { sessionManager } from '../sessionManager'
import { getSessionInputService } from '../task/session-input-runtime'
import { voiceInputService } from './runtime'
import { createRealtimeVoiceService } from './realtime-service'
import { controlRealtimeVoiceTask } from './realtime-task-control'
import { SupervisorStateStore } from '../task/supervisor-state'
import { pauseSessionContinuations } from '../routines/pause-session-continuations'

export const realtimeVoiceService = createRealtimeVoiceService({
  voice: voiceInputService,
  session: id => sessionManager.get(id)?.meta,
  inputs: {
    queue: (id, requestId, payload) => getSessionInputService(app.getPath('userData')).queue(id, requestId, payload),
    list: id => getSessionInputService(app.getPath('userData')).list(id),
    apply: (id, requestId, guard) => getSessionInputService(app.getPath('userData')).apply(id, requestId, guard),
    cancel: (id, requestId) => getSessionInputService(app.getPath('userData')).cancel(id, requestId)
  },
  control: (id, action) => {
    const root = app.getPath('userData'), store = new SupervisorStateStore(root)
    return controlRealtimeVoiceTask({
      session: id => sessionManager.get(id)?.meta,
      runId: id => sessionManager.getTaskRun(id)?.id,
      pauseContinuations: id => pauseSessionContinuations(join(root, 'routines'), id),
      getRun: id => store.getRun(id),
      claimLease: (id, revision) => sessionManager.claimSupervisorControlLease(store, id, revision),
      control: request => sessionManager.controlSupervisorRun(store, request),
      interrupt: id => sessionManager.interrupt(id)
    }, id, action)
  }
})
