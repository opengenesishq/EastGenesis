import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import type { ExternalEditorChoice, ExternalEditorId, WorkspaceBehaviorPreferences } from '../shared/workspace-behavior-types'
import { buildMinimalSubprocessEnv } from './security/subprocess-environment'

export function validateEditorProgram(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error('请选择本机编辑器程序。')
  const actual = realpathSync(path), info = statSync(actual)
  if (process.platform === 'darwin') {
    if (!actual.endsWith('.app') || !info.isDirectory() || !statSync(join(actual, 'Contents/Info.plist')).isFile()) throw new Error('请选择 macOS 编辑器 .app 应用。')
  } else {
    if (!info.isFile() || process.platform === 'win32' && !actual.toLowerCase().endsWith('.exe')) throw new Error('请选择本机编辑器可执行程序。')
    accessSync(actual, constants.X_OK)
  }
  return actual
}
export function listExternalEditorChoices(): ExternalEditorChoice[] {
  const mac = process.platform === 'darwin', win = process.platform === 'win32'
  const candidates: Array<[ExternalEditorId, string, string[]]> = mac ? [
    ['systemText', 'TextEdit', ['/System/Applications/TextEdit.app']],
    ['vscode', 'Visual Studio Code', ['/Applications/Visual Studio Code.app', join(homedir(), 'Applications/Visual Studio Code.app')]],
    ['cursor', 'Cursor', ['/Applications/Cursor.app', join(homedir(), 'Applications/Cursor.app')]],
    ['zed', 'Zed', ['/Applications/Zed.app', join(homedir(), 'Applications/Zed.app')]],
    ['sublime', 'Sublime Text', ['/Applications/Sublime Text.app']]
  ] : win ? [
    ['systemText', 'Notepad', [join(process.env.SystemRoot || 'C:\\Windows', 'System32/notepad.exe')]],
    ['vscode', 'Visual Studio Code', [join(process.env.LOCALAPPDATA || '', 'Programs/Microsoft VS Code/Code.exe'), join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code/Code.exe')]],
    ['cursor', 'Cursor', [join(process.env.LOCALAPPDATA || '', 'Programs/cursor/Cursor.exe')]],
    ['zed', 'Zed', [join(process.env.LOCALAPPDATA || '', 'Programs/Zed/Zed.exe')]],
    ['sublime', 'Sublime Text', [join(process.env.ProgramFiles || 'C:\\Program Files', 'Sublime Text/sublime_text.exe')]]
  ] : [
    ['systemText', 'Text editor', ['/usr/bin/gedit', '/usr/bin/kate', '/usr/bin/mousepad', '/usr/bin/xed']],
    ['vscode', 'Visual Studio Code', ['/usr/share/code/code', '/opt/visual-studio-code/code']],
    ['cursor', 'Cursor', ['/opt/Cursor/cursor', '/usr/bin/cursor']],
    ['zed', 'Zed', ['/usr/bin/zed', join(homedir(), '.local/bin/zed')]],
    ['sublime', 'Sublime Text', ['/opt/sublime_text/sublime_text']]
  ]
  return candidates.map(([id, name, paths]) => {
    for (const candidate of paths) { try { return { id, name, available: true, path: validateEditorProgram(candidate) } } catch { /* Try the next known installation. */ } }
    return { id, name, available: false }
  })
}
export function resolveExternalEditor(config: WorkspaceBehaviorPreferences): string {
  if (config.externalEditor === 'custom') {
    if (!config.customEditorPath) throw new Error('请在文件与终端设置中选择外部编辑器。')
    return validateEditorProgram(config.customEditorPath)
  }
  const editor = listExternalEditorChoices().find(choice => choice.id === config.externalEditor)
  if (!editor?.path) throw new Error('所选编辑器未安装，请在文件与终端设置中重新选择。')
  return editor.path
}
export function resolveEditorWorkspaceFile(cwd: string, path: string): string {
  if (typeof path !== 'string' || !path || path.length > 4096 || isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error('请选择当前任务内的文件。')
  const root = realpathSync(cwd), actual = realpathSync(resolve(root, path)), rel = relative(root, actual)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !statSync(root).isDirectory() || !statSync(actual).isFile()) throw new Error('文件不属于当前任务目录。')
  return actual
}
export async function launchExternalEditor(editor: string, file: string): Promise<void> {
  if (process.platform === 'darwin') return new Promise((resolveLaunch, reject) => {
    execFile('/usr/bin/open', ['-a', editor, '--', file], { env: buildMinimalSubprocessEnv(), timeout: 10000, maxBuffer: 16384 }, error => error ? reject(new Error('编辑器无法打开文件，请检查应用是否可用。')) : resolveLaunch())
  })
  return new Promise((resolveLaunch, reject) => {
    const child = spawn(editor, [file], { shell: false, stdio: 'ignore', env: buildMinimalSubprocessEnv(), windowsHide: false })
    child.once('error', () => reject(new Error('编辑器无法启动，请重新选择程序。')))
    child.once('spawn', () => { child.unref(); resolveLaunch() })
  })
}
