import { handleVoiceInputIpc } from './voice-input-handlers'
import { handleOfficeRevisionIpc } from './office-revision-handlers'
import { ipcMain } from 'electron'
import { handleProviderProfileIpc } from './provider-profile-handlers'
import { handleProviderProfileSyncIpc } from './provider-profile-sync-handlers'
import { handleProjectTestIpc } from './project-test-handlers'
import { handleProjectDebugIpc } from './project-debug-handlers'
import { handleProjectRefactorIpc } from './project-refactor-handlers'
import { handleStudioResultIpc } from './studio-result-handlers'
import { handleTaskPlanIpc } from './task-plan-handlers'
import { handleMediaIpc } from './media-handlers'
import { handleSessionQueryIpc } from './session-query-handlers'
import { registerPersonalTaskIpc } from './personal-task-handlers'

type AppFeature = 'voice-input' | 'office-revision' | 'task-plan' | 'studio-result' | 'media' | 'session-query' | 'provider-profile' | 'provider-profile-sync' | 'project-test' | 'project-debug' | 'project-refactor'

export function registerAppFeatureIpc(): void {
  registerPersonalTaskIpc()
  ipcMain.handle('appFeatures:invoke', (event, rawFeature: unknown, action: unknown, ...args: unknown[]) => {
    const feature = requiredFeature(rawFeature)
    if (feature === 'voice-input') return handleVoiceInputIpc(event, action, args[0])
    if (feature === 'office-revision') return handleOfficeRevisionIpc(event, action, args[0])
    if (feature === 'task-plan') return handleTaskPlanIpc(event, action, args[0], args[1])
    if (feature === 'studio-result') return handleStudioResultIpc(event, action, args[0], args[1])
    if (feature === 'media') return handleMediaIpc(event, action, ...args)
    if (feature === 'session-query') return handleSessionQueryIpc(event, action, ...args)
    if (feature === 'project-test') return handleProjectTestIpc(event, action, args[0], args[1])
    if (feature === 'project-debug') return handleProjectDebugIpc(event, action, args[0], ...args.slice(1))
    if (feature === 'project-refactor') return handleProjectRefactorIpc(event, action, args[0], args[1])
    if (feature === 'provider-profile-sync') return handleProviderProfileSyncIpc(event, action, ...args)
    return handleProviderProfileIpc(event, action, ...args)
  })
}

function requiredFeature(value: unknown): AppFeature {
  if (value === 'voice-input' || value === 'office-revision' || value === 'task-plan' || value === 'studio-result' || value === 'media' || value === 'session-query' || value === 'provider-profile' || value === 'provider-profile-sync' || value === 'project-test' || value === 'project-debug' || value === 'project-refactor') return value
  throw new Error('App feature is invalid')
}
