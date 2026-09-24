import { reconcileWorkspaceHandoffTarget } from '../workspace-handoff'
import { reconcileTaskHandoffEffectTarget } from '../task-handoff/effect'
import type { EffectTarget } from '../../shared/effect-types'
import { reconcileCodeForgePatchEffectTarget } from '../code-forge/patch-effect'
import { reconcileGitIndexEffectTarget } from '../git/git-index-effect'
import { reconcileManagedWorktreeLifecycleTarget } from '../git/managed-worktree-effect'
import { reconcileManagedPluginEffectTarget } from '../plugin/plugin-directory-effect'
import type { EffectReconciliationResult } from './effect-reconciliation-result'
import { reconcileMigrationOperationEffectTarget } from '../migration-operation-effect'

export function reconcileLocalEffectTarget(target: EffectTarget): EffectReconciliationResult | undefined {
  switch (target.kind) {
    case 'task_handoff':
      return reconcileTaskHandoffEffectTarget(target)
    case 'workspace_handoff':
      return reconcileWorkspaceHandoffTarget(target)
    case 'git_index_update':
      return reconcileGitIndexEffectTarget(target)
    case 'code_forge_patch':
      return reconcileCodeForgePatchEffectTarget(target)
    case 'git_worktree_create':
    case 'git_worktree_remove':
      return reconcileManagedWorktreeLifecycleTarget(target)
    case 'managed_plugin_install':
    case 'managed_plugin_uninstall':
      return reconcileManagedPluginEffectTarget(target)
    case 'migration_operation':
      return reconcileMigrationOperationEffectTarget(target)
    default:
      return undefined
  }
}
