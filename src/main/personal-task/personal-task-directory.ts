import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { PersonalTaskBinding } from '../../shared/personal-task-types'
import { PersonalTaskSubmissionError } from './personal-task-input'

export function personalTaskDirectory(rootDir: string, binding: PersonalTaskBinding): string {
  if (!/^work-item-[a-f0-9]{24}$/.test(binding.workItemId)) throw new Error('个人任务目录身份无效')
  return join(realpathSync(rootDir), 'personal-workspace', 'tasks', binding.workItemId)
}

/** Each task owns one directory; shared personal Workspace membership never grants sibling file scope. */
export function ensurePersonalTaskDirectory(rootDir: string, binding: PersonalTaskBinding): string {
  const root = realpathSync(rootDir)
  const personal = join(root, 'personal-workspace')
  const tasks = join(personal, 'tasks')
  const cwd = personalTaskDirectory(root, binding)
  for (const directory of [personal, tasks, cwd]) {
    try { mkdirSync(directory, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    verifyDirectory(directory)
    if (process.platform !== 'win32') chmodSync(directory, 0o700)
  }
  return cwd
}

export function verifyPersonalTaskDirectory(rootDir: string, binding: PersonalTaskBinding, cwd: string): void {
  const expected = personalTaskDirectory(rootDir, binding)
  if (resolve(cwd) !== expected) directoryError()
  const personal = join(realpathSync(rootDir), 'personal-workspace')
  for (const directory of [personal, join(personal, 'tasks'), expected]) verifyDirectory(directory)
}

function verifyDirectory(directory: string): void {
  const stats = lstatSync(directory)
  if (!stats.isDirectory() || stats.isSymbolicLink() || realpathSync(directory) !== directory) directoryError()
}

function directoryError(): never {
  throw new PersonalTaskSubmissionError('PERSONAL_TASK_DIRECTORY_CONFLICT', '个人任务目录归属不一致，已停止执行')
}
