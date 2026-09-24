import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { PluginInstallResult } from '../../shared/plugin-types'
import { installPreparedPluginWithEffect } from '../pluginInstallEffect'
import { getTaskSnapshot, listTaskRuns } from '../task/task-snapshot'
import { reconcileInteractiveOperationSnapshot } from '../ipc/operation-snapshot'
import type { ManagedPluginInstallTarget, PreparedPluginInstall } from './plugin-directory-effect'

export interface CatalogInstallation {
  install(prepared: PreparedPluginInstall, target: ManagedPluginInstallTarget): Promise<PluginInstallResult>
  reconcile(operationId: string, target: ManagedPluginInstallTarget): Promise<PluginInstallResult>
}
export function catalogInstallation(rootDir: string): CatalogInstallation {
  return {
    install: (prepared, target) => installPreparedPluginWithEffect(prepared, target, rootDir),
    async reconcile(operationId, target) {
      const scope = `operation:${operationId}`, snapshot = await getTaskSnapshot(scope, rootDir)
      if (snapshot) await reconcileInteractiveOperationSnapshot(snapshot, { requireStored: true, rootDir })
      const runs = await listTaskRuns(scope, rootDir)
      const run = runs.find(row => row.operation?.operationId === operationId)
      const effects = run?.effects ?? []
      if (!snapshot && !run || run?.status === 'failed' && effects.length === 0) {
        return { ok: false, operationId, effectStatus: 'failed', error: '原操作未越过安装执行记录屏障，未执行安装；可重新准备。' }
      }
      const original = effects.find(effect => effect.target.kind === 'managed_plugin_install' && isDeepStrictEqual(effect.target, target))
      if (original?.status === 'compensated') return { ok: false, operationId, effectStatus: 'compensated', error: '原插件安装已补偿撤销，未保留本次安装。' }
      if (original?.status === 'confirmed') {
        return { ok: true, name: target.pluginName, installedPath: join(target.rootPath, target.pluginName), operationId, effectStatus: original.status }
      }
      if (original && original.status === 'failed') return { ok: false, operationId, effectStatus: 'failed', error: original.error ?? '原安装已确认未完成，请重新准备。' }
      return { ok: false, operationId, snapshotId: scope, effectStatus: 'waiting_reconciliation', error: '原安装尚未确认；保留同一操作记录，请在恢复面板核对。' }
    }
  }
}
