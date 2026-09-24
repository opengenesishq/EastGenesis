import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { EffectRecord } from '../shared/effect-types'
import type { PluginInstallResult, PluginUninstallResult } from '../shared/types'
import {
  executeManagedPluginInstallTarget,
  executeManagedPluginUninstallTarget,
  pluginInstallToolInput,
  pluginUninstallToolInput,
  preparePluginInstall,
  preparePluginUninstall,
  type ManagedPluginInstallTarget,
  type ManagedPluginUninstallTarget,
  type PluginTransitionHooks,
  type PreparedPluginInstall,
  type PreparedPluginUninstall
} from './plugin/plugin-directory-effect'
import {
  executeInteractiveOperationEffect,
  type InteractiveOperationEffectOutcome
} from './task/operation-effect-gateway'

type OperationGateway = typeof executeInteractiveOperationEffect

export interface PluginInstallEffectDependencies {
  runOperation?: OperationGateway
  installRunner?: (
    target: ManagedPluginInstallTarget,
    sourcePath: string,
    hooks?: PluginTransitionHooks
  ) => PluginInstallResult
  uninstallRunner?: (
    target: ManagedPluginUninstallTarget,
    hooks?: PluginTransitionHooks
  ) => PluginUninstallResult
  hooks?: PluginTransitionHooks
}

export async function installLocalPluginWithEffect(
  sourcePath: string,
  pluginsRoot: string,
  overwrite = false,
  dependencies: PluginInstallEffectDependencies = {}
): Promise<PluginInstallResult> {
  const transitionId = createTransitionId()
  const prepared = preparePluginInstall(sourcePath, pluginsRoot, overwrite, transitionId)
  if ('ok' in prepared) return prepared
  return installPreparedPluginWithEffect(prepared, undefined, undefined, dependencies)
}

/** Catalog previews retain their operation id and frozen source/target. The caller
 * persists intent before calling and reconciles retries rather than executing again. */
export async function installPreparedPluginWithEffect(
  prepared: PreparedPluginInstall,
  reviewedTarget?: ManagedPluginInstallTarget,
  rootDir?: string,
  dependencies: PluginInstallEffectDependencies = {}
): Promise<PluginInstallResult> {
  const outcome = await (dependencies.runOperation ?? executeInteractiveOperationEffect)({
    rootDir,
    operationId: prepared.transitionId,
    kind: 'plugin_install',
    title: '安装本地插件',
    sourceSessionId: 'plugin-management:settings',
    cwd: prepared.operationCwd,
    toolName: 'managed_plugin_install',
    toolInput: pluginInstallToolInput(prepared),
    execute: (effect) => {
      if (reviewedTarget && !isDeepStrictEqual(effect.target, reviewedTarget)) {
        return { ok: false, error: '插件安装目标在预览后发生变化，请重新准备预览。' }
      }
      return runInstall(effect, prepared, dependencies)
    },
    isSuccess: (result) => result.ok,
    resultSummary: summarizeInstallResult
  })
  return projectInstallOutcome(outcome)
}

export async function uninstallPluginWithEffect(
  targetPath: string,
  pluginsRoot: string,
  dependencies: PluginInstallEffectDependencies = {}
): Promise<PluginUninstallResult> {
  const transitionId = createTransitionId()
  const prepared = preparePluginUninstall(targetPath, pluginsRoot, transitionId)
  if ('ok' in prepared) return prepared
  const outcome = await (dependencies.runOperation ?? executeInteractiveOperationEffect)({
    operationId: transitionId,
    kind: 'plugin_uninstall',
    title: '卸载托管插件',
    sourceSessionId: 'plugin-management:settings',
    cwd: prepared.operationCwd,
    toolName: 'managed_plugin_uninstall',
    toolInput: pluginUninstallToolInput(prepared),
    execute: (effect) => runUninstall(effect, prepared, dependencies),
    isSuccess: (result) => result.ok,
    resultSummary: summarizeUninstallResult
  })
  return projectUninstallOutcome(outcome)
}

function runInstall(
  effect: EffectRecord,
  prepared: PreparedPluginInstall,
  dependencies: PluginInstallEffectDependencies
): PluginInstallResult {
  if (effect.target.kind !== 'managed_plugin_install') {
    return { ok: false, error: '插件安装 EffectTarget 类型不匹配' }
  }
  return (dependencies.installRunner ?? executeManagedPluginInstallTarget)(
    effect.target,
    prepared.sourcePath,
    dependencies.hooks
  )
}

function runUninstall(
  effect: EffectRecord,
  _prepared: PreparedPluginUninstall,
  dependencies: PluginInstallEffectDependencies
): PluginUninstallResult {
  if (effect.target.kind !== 'managed_plugin_uninstall') {
    return { ok: false, error: '插件卸载 EffectTarget 类型不匹配' }
  }
  return (dependencies.uninstallRunner ?? executeManagedPluginUninstallTarget)(
    effect.target,
    dependencies.hooks
  )
}

function projectInstallOutcome(
  outcome: InteractiveOperationEffectOutcome<PluginInstallResult>
): PluginInstallResult {
  if (outcome.status === 'completed') {
    if (outcome.effectStatus === 'compensated') {
      return { ok: false, error: '原插件安装已补偿撤销，未保留本次安装。', effectStatus: 'compensated', operationId: outcome.operationId }
    }
    if (outcome.value?.ok) {
      return { ...outcome.value, effectStatus: outcome.effectStatus, operationId: outcome.operationId }
    }
    if (outcome.effect.target.kind === 'managed_plugin_install') {
      const target = outcome.effect.target
      return {
        ok: true,
        installedPath: join(target.rootPath, target.pluginName),
        name: target.pluginName,
        effectStatus: outcome.effectStatus,
        operationId: outcome.operationId
      }
    }
    return {
      ok: false,
      error: '插件安装完成态目标类型不匹配',
      effectStatus: outcome.effectStatus,
      operationId: outcome.operationId
    }
  }
  if (outcome.status === 'failed') {
    return outcome.value
      ? { ...outcome.value, effectStatus: outcome.effectStatus, operationId: outcome.operationId }
      : {
          ok: false,
          error: outcome.error,
          effectStatus: outcome.effectStatus,
          operationId: outcome.operationId
        }
  }
  return {
    ok: false,
    error: '插件安装结果未知，请在恢复面板完成对账',
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId,
    snapshotId: outcome.snapshotId
  }
}

function projectUninstallOutcome(
  outcome: InteractiveOperationEffectOutcome<PluginUninstallResult>
): PluginUninstallResult {
  if (outcome.status === 'completed') {
    if (outcome.value?.ok) {
      return { ...outcome.value, effectStatus: outcome.effectStatus, operationId: outcome.operationId }
    }
    if (outcome.effect.target.kind === 'managed_plugin_uninstall') {
      const target = outcome.effect.target
      return {
        ok: true,
        trashedTo: join(target.rootPath, target.trashRelativePath),
        effectStatus: outcome.effectStatus,
        operationId: outcome.operationId
      }
    }
    return {
      ok: false,
      error: '插件卸载完成态目标类型不匹配',
      effectStatus: outcome.effectStatus,
      operationId: outcome.operationId
    }
  }
  if (outcome.status === 'failed') {
    return outcome.value
      ? { ...outcome.value, effectStatus: outcome.effectStatus, operationId: outcome.operationId }
      : {
          ok: false,
          error: outcome.error,
          effectStatus: outcome.effectStatus,
          operationId: outcome.operationId
        }
  }
  return {
    ok: false,
    error: '插件卸载结果未知，请在恢复面板完成对账',
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId,
    snapshotId: outcome.snapshotId
  }
}

function summarizeInstallResult(result: PluginInstallResult): string {
  return JSON.stringify({ ok: result.ok, name: result.name })
}

function summarizeUninstallResult(result: PluginUninstallResult): string {
  return JSON.stringify({ ok: result.ok })
}

function createTransitionId(): string {
  return randomUUID().replace(/-/g, '')
}
