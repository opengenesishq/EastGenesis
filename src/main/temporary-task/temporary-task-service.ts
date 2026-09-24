import { app, ipcMain, shell } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { assertTrustedWorkflowLedgerSender } from '../ipc/workflow-ledger-handlers'
import { getSettings } from '../settings'
import { loadProviderProfileStore, persistedProviders } from '../providers'
import { buildMinimalSubprocessEnv } from '../security/subprocess-environment'
import { writeDurableFileSync } from '../durable-file'
import { createTemporaryProfile, listTemporaryProfiles, profilePath, readTemporaryProfile,
  removeTemporaryProfile, saveTemporaryProfile, temporaryProfileView, temporaryRuntimeFromEnvironment } from './profile-store'
import { temporaryProviders, temporarySettings } from './profile-seed'
import type { TemporaryTaskProfileView, TemporaryTaskState } from '../../shared/temporary-task-types'

const children = new Map<string, ChildProcess>()
const ending = new Map<string, Promise<void>>()
let launching: Promise<TemporaryTaskProfileView> | undefined
export function temporaryTaskState(): TemporaryTaskState {
  const runtime = temporaryRuntimeFromEnvironment(process.env)
  return runtime ? { temporary: true, profileId: runtime.id, profiles: [] }
    : { temporary: false, profiles: listTemporaryProfiles(app.getPath('userData')).map(profile => ({ ...profile, canEnd: children.has(profile.id) })) }
}
export function openTemporaryTask(): Promise<TemporaryTaskProfileView> {
  if (launching) return launching
  launching = launch().finally(() => { launching = undefined })
  return launching
}
async function launch(): Promise<TemporaryTaskProfileView> {
  if (temporaryRuntimeFromEnvironment(process.env)) throw new Error('当前窗口已经是临时工作空间。')
  const parentRoot = app.getPath('userData'), record = createTemporaryProfile(parentRoot)
  try {
    writeDurableFileSync(join(record.root, 'providers.json'), JSON.stringify({ schemaVersion: 1, format: 'caogen.provider-store.v1',
      entries: temporaryProviders(persistedProviders(loadProviderProfileStore())) }))
    writeDurableFileSync(join(record.root, 'settings.json'), JSON.stringify({ _schemaVersion: 1, ...temporarySettings(getSettings()) }))
    const env: NodeJS.ProcessEnv = { ...buildMinimalSubprocessEnv(),
      CAOGEN_USER_DATA_DIR: record.root, CAOGEN_TEMPORARY_PROFILE_ID: record.id, CAOGEN_MEMORY_DIR: join(record.root, 'memory'),
      ...(process.env.ELECTRON_RENDERER_URL ? { ELECTRON_RENDERER_URL: process.env.ELECTRON_RENDERER_URL } : {}) }
    const child = spawn(process.execPath, app.isPackaged ? [] : [app.getAppPath()], {
      cwd: join(record.root, 'personal-workspace'), env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: false
    })
    children.set(record.id, child)
    child.once('exit', () => {
      children.delete(record.id)
      try {
        const latest = readTemporaryProfile(record.root)
        saveTemporaryProfile({ ...latest, state: 'exited' })
        // The actual spawned process exited before its registered directory is removed.
        removeTemporaryProfile(parentRoot, record.id, () => false)
      } catch { console.error('[caogen] 临时资料清理未完成，请在临时任务入口清理残留。') }
    })
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    const latest = readTemporaryProfile(record.root)
    saveTemporaryProfile({ ...latest, childPid: child.pid, state: 'running' })
    return { ...temporaryProfileView({ ...latest, childPid: child.pid, state: 'running' }), canEnd: true }
  } catch {
    if (!children.get(record.id)?.pid) {
      children.delete(record.id)
      saveTemporaryProfile({ ...record, state: 'exited' })
      removeTemporaryProfile(parentRoot, record.id, () => false)
    }
    throw new Error('临时窗口未能启动，请检查应用安装；原任务未改变。')
  }
}
/** Only this parent process can end children it actually launched. A signal is not exit evidence. */
export function endTemporaryTask(id: string): Promise<void> {
  const existing = ending.get(id)
  if (existing) return existing
  const child = children.get(id)
  if (!child) return Promise.reject(new Error('此临时窗口不由当前主窗口管理，请在该临时窗口内结束。'))
  const root = profilePath(app.getPath('userData'), id)
  const pending = new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(force); clearTimeout(timeout)
      if (existsSync(root)) reject(new Error('临时窗口已结束，但资料尚未清理；请使用“清理残留”。'))
      else resolve()
    }
    const terminate = (): void => { try { child.kill('SIGTERM') } catch { /* Exit remains the completion signal. */ } }
    const force = setTimeout(terminate, 10_000)
    const timeout = setTimeout(() => {
      clearTimeout(force); child.removeListener('exit', finish)
      reject(new Error('临时窗口尚未退出，资料已保留。请稍后重试，或在临时窗口内结束。'))
    }, 15_000)
    child.once('exit', finish)
    if (child.exitCode !== null || child.signalCode !== null) { child.removeListener('exit', finish); finish(); return }
    if (child.connected) child.send({ kind: 'temporary-task:finish', profileId: id }, error => { if (error) terminate() })
    else terminate()
  }).finally(() => { ending.delete(id) })
  ending.set(id, pending)
  return pending
}
/** Quitting the main app also ends its temporary windows; removal stays in the observed exit handler. */
export async function finishTemporaryTaskChildren(): Promise<void> {
  const outcomes = await Promise.allSettled([...children.keys()].map(endTemporaryTask))
  if (outcomes.some(result => result.status === 'rejected')) console.error('[caogen] 部分临时窗口尚未完成退出或资料清理，登记目录已保留。')
}
export function registerTemporaryTaskIpc(): void {
  ipcMain.handle('temporary-task:state', event => { assertTrustedWorkflowLedgerSender(event); return temporaryTaskState() })
  ipcMain.handle('temporary-task:open', event => { assertTrustedWorkflowLedgerSender(event); return openTemporaryTask() })
  ipcMain.handle('temporary-task:end', (event, id: string) => { assertTrustedWorkflowLedgerSender(event); return endTemporaryTask(id) })
  ipcMain.handle('temporary-task:clean', (event, id: string) => {
    assertTrustedWorkflowLedgerSender(event)
    if (temporaryRuntimeFromEnvironment(process.env)) throw new Error('请在主窗口清理已结束的临时资料。')
    const root = app.getPath('userData')
    readTemporaryProfile(profilePath(root, id)); removeTemporaryProfile(root, id)
  })
  ipcMain.handle('temporary-task:finish', event => {
    assertTrustedWorkflowLedgerSender(event)
    if (!temporaryRuntimeFromEnvironment(process.env)) throw new Error('当前不是临时窗口。')
    app.quit()
  })
  ipcMain.handle('temporary-task:files', async event => {
    assertTrustedWorkflowLedgerSender(event)
    const runtime = temporaryRuntimeFromEnvironment(process.env)
    if (!runtime) throw new Error('当前不是临时窗口。')
    const path = join(runtime.root, 'personal-workspace')
    mkdirSync(path, { recursive: true, mode: 0o700 })
    if (await shell.openPath(path)) throw new Error('无法打开临时成果目录。')
  })
}
