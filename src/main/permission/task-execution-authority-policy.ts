import { lstatSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { TASK_EXECUTION_AUTHORITY_WRITE_TOOLS, type TaskExecutionAuthorityWriteTool } from '../../shared/task-execution-authority-types'
import { normalizeToolName } from '../task/tool-idempotency'
import { isLimitedFileExecutionReadOnlyCall } from './limited-file-execution-policy'
import { classifyToolRisk, matchesRelativePermissionPathPattern } from './tool-permission'

export type TaskExecutionAuthorityScope = {
  allowedWriteTools: readonly TaskExecutionAuthorityWriteTool[]
  pathPatterns: readonly string[]
  allowedCommandPatterns: readonly string[]
}
type TaskExecutionAuthorityScopeInput = Omit<TaskExecutionAuthorityScope, 'allowedCommandPatterns'> & {
  allowedCommandPatterns?: readonly string[]
}

export function normalizeTaskExecutionAuthorityScope(raw: TaskExecutionAuthorityScopeInput): TaskExecutionAuthorityScope {
  const tools = raw.allowedWriteTools, paths = raw.pathPatterns
  const commands = raw.allowedCommandPatterns === undefined ? [] : raw.allowedCommandPatterns
  if (!Array.isArray(tools) || new Set(tools).size !== tools.length ||
    tools.some(tool => !TASK_EXECUTION_AUTHORITY_WRITE_TOOLS.includes(tool))) throw new Error('任务文件工具范围无效。')
  if (!Array.isArray(paths) || paths.length > 32 || new Set(paths).size !== paths.length || paths.some(path =>
    typeof path !== 'string' || !path || path !== path.trim() || path.length > 500 || isAbsolute(path) || /^[A-Za-z]:/.test(path) ||
    /[\\\x00-\x1f\x7f?\[\]{}]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')
  )) throw new Error('任务路径必须是工作目录内的相对路径或 *、** 通配范围，例如 docs/**。')
  if (!Array.isArray(commands) || commands.length > 32 || new Set(commands).size !== commands.length || commands.some(command =>
    typeof command !== 'string' || !command || command !== command.trim() || command.length > 2000 || /[\x00-\x1f\x7f]/.test(command)
  )) throw new Error('任务命令范围无效；最多 32 条，每条须为 2000 字符以内且不含控制字符的完整命令。')
  if (Boolean(tools.length) !== Boolean(paths.length)) throw new Error('文件授权必须同时指定文件工具和相对路径；仅授权命令时请清空文件工具和路径。')
  if (!tools.length && !commands.length) throw new Error('请至少授权一组文件范围或一条完整命令。')
  return { allowedWriteTools: TASK_EXECUTION_AUTHORITY_WRITE_TOOLS.filter(tool => tools.includes(tool)), pathPatterns: [...paths].sort(), allowedCommandPatterns: [...commands].sort() }
}

/** Adds a per-task restriction. It cannot confer authority over any global rule. */
export function taskExecutionAuthorityPolicyError(scope: TaskExecutionAuthorityScope, name: string, input: Record<string, unknown>, cwd: string): string | undefined {
  const toolName = normalizeToolName(name)
  if (isLimitedFileExecutionReadOnlyCall(toolName, input)) return undefined
  if (toolName === 'bash') {
    const command = input.command
    // Match the command as supplied to the shell. No trimming, prefix matching or
    // wildcard expansion here: appended shell operators must be authorized anew.
    if (typeof command === 'string' && scope.allowedCommandPatterns.includes(command)) return undefined
    return '任务限定执行已阻止此工具（bash 命令）：当前任务没有匹配的独立命令授权。'
  }
  if (!scope.allowedWriteTools.includes(toolName as TaskExecutionAuthorityWriteTool)) return '任务限定执行已阻止此工具：仅允许明确授权的文件工具，命令、桌面、连接器及委派不能借用文件授权。'
  const risk = classifyToolRisk(toolName, input, cwd)
  if (risk.invalidInput || risk.pathInsideCwd !== true || !risk.paths?.length) return '任务限定执行缺少可核验的工作目录内文件路径。'
  try {
    for (const target of risk.paths) {
      const path = relative(cwd, target).replace(/\\/g, '/')
      if (!path || isAbsolute(path) || path === '..' || path.startsWith('../') ||
        !scope.pathPatterns.some(pattern => matchesRelativePermissionPathPattern(pattern, path))) return '此文件路径未获得当前任务的修改授权。'
      let current = cwd
      for (const part of path.split('/')) {
        current = join(current, part)
        try { if (lstatSync(current).isSymbolicLink()) return '任务授权路径包含符号链接，不能借此扩大可写范围。' }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error }
      }
    }
  } catch { return '任务授权文件路径不可验证。' }
  return undefined
}
