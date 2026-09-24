import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { writeDurableFileSync } from '../durable-file'
import type { TemporaryTaskProfileView } from '../../shared/temporary-task-types'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const MARKER = 'temporary-task-profile.json'
export interface TemporaryProfile {
  schemaVersion: 1
  id: string
  root: string
  createdAt: number
  parentPid: number
  childPid?: number
  state: 'starting' | 'running' | 'exited'
}
export function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}
function registryRoot(parentRoot: string): string { return join(realpathSync(resolve(parentRoot)), 'temporary-task-profiles') }
export function profilePath(parentRoot: string, id: string): string {
  if (!UUID.test(id)) throw new Error('临时窗口标识无效。')
  return join(registryRoot(parentRoot), id)
}
function assertDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path)) throw new Error('临时资料目录不是登记的独立目录。')
}
export function readTemporaryProfile(root: string): TemporaryProfile {
  assertDirectory(root)
  const file = join(root, MARKER), stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('临时资料登记文件无效。')
  const record = JSON.parse(readFileSync(file, 'utf8')) as TemporaryProfile
  if (record.schemaVersion !== 1 || !UUID.test(record.id) || record.root !== resolve(root) ||
      basename(root) !== record.id || basename(dirname(root)) !== 'temporary-task-profiles' ||
      !Number.isSafeInteger(record.parentPid) || record.parentPid <= 0 || !Number.isFinite(record.createdAt) ||
      (record.childPid !== undefined && (!Number.isSafeInteger(record.childPid) || record.childPid <= 0)) ||
      !['starting', 'running', 'exited'].includes(record.state)) throw new Error('临时资料登记与目录不匹配。')
  return record
}
export function saveTemporaryProfile(record: TemporaryProfile): void {
  assertDirectory(record.root)
  writeDurableFileSync(join(record.root, MARKER), JSON.stringify(record))
}
export function createTemporaryProfile(parentRoot: string): TemporaryProfile {
  const registry = registryRoot(parentRoot)
  mkdirSync(registry, { recursive: true, mode: 0o700 }); assertDirectory(registry)
  const id = randomUUID(), root = profilePath(parentRoot, id)
  mkdirSync(root, { mode: 0o700 })
  for (const name of ['chromium', 'logs', 'crash-dumps', 'memory', 'personal-workspace']) mkdirSync(join(root, name), { mode: 0o700 })
  const record: TemporaryProfile = { schemaVersion: 1, id, root, parentPid: process.pid, createdAt: Date.now(), state: 'starting' }
  saveTemporaryProfile(record)
  return record
}
export function temporaryProfileView(record: TemporaryProfile, alive = processIsAlive): TemporaryTaskProfileView {
  const running = record.childPid !== undefined && alive(record.childPid)
  const starting = record.state === 'starting' && record.childPid === undefined &&
    (alive(record.parentPid) || Date.now() - record.createdAt < 60_000)
  return { id: record.id, createdAt: record.createdAt, state: running ? 'running' : starting ? 'starting' : 'cleanup_pending' }
}
export function listTemporaryProfiles(parentRoot: string): TemporaryTaskProfileView[] {
  const registry = registryRoot(parentRoot)
  if (!existsSync(registry)) return []
  assertDirectory(registry)
  return readdirSync(registry).filter(name => UUID.test(name)).map(id => temporaryProfileView(readTemporaryProfile(profilePath(parentRoot, id))))
}
export function removeTemporaryProfile(parentRoot: string, id: string, alive = processIsAlive): void {
  assertDirectory(registryRoot(parentRoot))
  const root = profilePath(parentRoot, id)
  if (!existsSync(root)) return
  const record = readTemporaryProfile(root)
  if (temporaryProfileView(record, alive).state !== 'cleanup_pending') throw new Error('临时进程仍在运行或启动，不能清理其资料。')
  rmSync(root, { recursive: true, force: false })
}
export function temporaryRuntimeFromEnvironment(env: NodeJS.ProcessEnv): TemporaryProfile | undefined {
  if (!env.CAOGEN_TEMPORARY_PROFILE_ID) return undefined
  const root = env.CAOGEN_USER_DATA_DIR
  if (!root) throw new Error('临时运行缺少独立资料目录。')
  const record = readTemporaryProfile(root)
  if (record.id !== env.CAOGEN_TEMPORARY_PROFILE_ID || record.state === 'exited') throw new Error('临时运行登记无效。')
  return record
}
