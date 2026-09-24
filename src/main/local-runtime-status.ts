import { execFile } from 'node:child_process'
import { access, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import type { LocalRuntimeInfo, LocalRuntimeStatus } from '../shared/local-runtime-types'
import { buildMinimalSubprocessEnv } from './security/subprocess-environment'

const require = createRequire(import.meta.url)
let pending: Promise<LocalRuntimeStatus> | undefined
/** Fixed --version probes only. No command, directory, environment or package name comes from the renderer. */
export function inspectLocalRuntimes(): Promise<LocalRuntimeStatus> {
  if (pending) return pending
  pending = inspect().finally(() => { pending = undefined })
  return pending
}
async function inspect(): Promise<LocalRuntimeStatus> {
  const runtimes = await Promise.all([
    probe('node', 'Node.js', process.platform === 'win32' ? ['node.exe'] : ['node']),
    probe('python', 'Python', process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python']),
    probe('git', 'Git', process.platform === 'win32' ? ['git.exe'] : ['git'])
  ])
  let bundledDocuments = true
  for (const dependency of ['docx', 'exceljs', 'pptxgenjs', 'pdfkit']) {
    try { require.resolve(dependency) } catch { bundledDocuments = false }
  }
  return { checkedAt: Date.now(), platform: process.platform, runtimes, bundledDocuments }
}
async function probe(id: LocalRuntimeInfo['id'], name: string, names: string[]): Promise<LocalRuntimeInfo> {
  const directories = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(path => path && isAbsolute(path))
  let failed: LocalRuntimeInfo | undefined
  const seen = new Set<string>()
  for (const binary of names) for (const directory of directories) {
    let executable: string
    try {
      executable = await realpath(join(directory, binary))
      await access(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    } catch { continue }
    if (seen.has(executable)) continue
    seen.add(executable)
    const result = await new Promise<LocalRuntimeInfo>(resolve => {
      execFile(executable, ['--version'], { cwd: tmpdir(), env: buildMinimalSubprocessEnv(), timeout: 4000, maxBuffer: 16 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        const version = `${stdout}\n${stderr}`.trim().split(/\r?\n/).find(line => /(?:^v?\d+\.\d+|Python \d+\.\d+|git version \d+\.\d+)/i.test(line))?.slice(0, 120)
        if (error || !version) resolve({ id, name, available: false, executable, error: error && 'killed' in error && error.killed ? 'timeout' : 'probe_failed' })
        else resolve({ id, name, available: true, executable, version })
      })
    })
    if (result.available) return result
    failed ??= result
    if (seen.size >= 4) return failed
  }
  return failed ?? { id, name, available: false, error: 'not_found' }
}
