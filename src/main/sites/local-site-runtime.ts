import { app } from 'electron'
import { sessionManager } from '../sessionManager'
import { getSettings } from '../settings'
import { evaluateToolPermission } from '../permission/tool-permission'
import { LocalSiteCatalogService } from './local-site-catalog'
import { LocalSitePreviewService } from './local-site-preview'
import { isSiteDeploymentActive } from './site-deployment-service'

function assertRead(id: string, path: string): void {
  const meta = sessionManager.get(id)?.meta
  if (!meta || meta.status === 'closed') throw new Error('原任务已关闭。')
  const decision = evaluateToolPermission(getSettings(), { toolName: 'read_file', input: { path }, cwd: meta.cwd })
  if (decision.kind === 'deny') throw new Error(decision.reason)
}
let catalog: LocalSiteCatalogService | undefined, previews: LocalSitePreviewService | undefined
export function localSiteCatalogService(): LocalSiteCatalogService {
  return catalog ??= new LocalSiteCatalogService({ root: () => app.getPath('userData'), session: id => sessionManager.get(id)?.meta,
    assertRead: async (id, path) => { await sessionManager.assertInteractiveExecutionAuthorized(id, '读取当前任务静态网站'); assertRead(id, path) }, isExecuting: isSiteDeploymentActive })
}
export function localSitePreviewService(): LocalSitePreviewService {
  return previews ??= new LocalSitePreviewService({ root: () => app.getPath('userData'), session: id => sessionManager.get(id)?.meta,
    authorize: id => sessionManager.assertInteractiveExecutionAuthorized(id, '预览当前任务静态网站'), assertRead })
}
