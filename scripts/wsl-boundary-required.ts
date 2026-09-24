import assert from 'node:assert/strict'
import { inspectWslSync, parseWslDistributions } from '../src/main/wsl/discovery'
import { checkWslDirectoryMapping, guestPathToHost, parseWslHostPath, resolveTaskExecutionEnvironment } from '../src/main/wsl/binding'
import { parseGitAlternatePaths, prepareExecutionProcess, type ExecutionProcessHost } from '../src/main/wsl/process'

let groups = 0
const listing = '\ufeff  NAME            STATE           VERSION\r\n* Ubuntu          已停止          2\r\n  Legacy          Running         1\r\n'
const parsed = parseWslDistributions(Buffer.from(listing, 'utf16le'))
assert.deepEqual(parsed.map(row => [row.name, row.version, row.isDefault]), [['Ubuntu', 2, true], ['Legacy', 1, false]])
const ready = inspectWslSync({ platform: 'win32', run: args => args.includes('--quiet') ? Buffer.from('Ubuntu\r\nLegacy\r\n', 'utf16le') : Buffer.from(listing, 'utf16le') })
assert.equal(ready.available, true); groups++

let probes = 0
assert.equal(inspectWslSync({ platform: 'darwin', run: () => { probes++; throw new Error('must not execute') } }).available, false)
assert.equal(probes, 0)
assert.equal(inspectWslSync({ platform: 'win32', run: args => args.includes('--quiet') ? 'Ubuntu\nOther\n' : listing }).available, false)
assert.equal(inspectWslSync({ platform: 'win32', run: args => args.includes('--quiet') ? 'Legacy\n' : 'Legacy          Stopped          1\n' }).available, false)
assert.equal(inspectWslSync({ platform: 'win32', run: () => { throw new Error('timeout') } }).available, false); groups++

const cwd = String.raw`\\wsl.localhost\Ubuntu\home\用户\project space`
assert.equal(parseWslHostPath(cwd)?.guestPath, '/home/用户/project space')
assert.equal(parseWslHostPath(cwd.replace('wsl.localhost', 'wsl$'))?.distribution, 'Ubuntu')
assert.throws(() => parseWslHostPath(String.raw`\\wsl.localhost\Ubuntu\home\..\secret`))
assert.throws(() => parseWslHostPath(String.raw`\\wsl.localhost\bad distro\home`))
assert.throws(() => parseWslHostPath(cwd + '\n'))
assert.throws(() => guestPathToHost('Ubuntu', '/home/../secret'))
assert.throws(() => guestPathToHost('Ubuntu', '/home/a:b')); groups++

const binding = checkWslDirectoryMapping('Ubuntu', cwd, ['/home/用户/project space', cwd.replace('wsl.localhost', 'wsl$'), '10:20'], '30:40')
assert.equal(binding.hostCwd, cwd)
assert.throws(() => checkWslDirectoryMapping('Ubuntu', cwd, ['/home/用户/project space', cwd.replace('Ubuntu', 'Debian'), '10:20'], '30:40'))
assert.throws(() => checkWslDirectoryMapping('Ubuntu', cwd, ['/home/用户/Project Space', cwd, '10:20'], '30:40'))
assert.throws(() => checkWslDirectoryMapping('Ubuntu', cwd, ['/mnt/c/projects', 'C:\\projects', '10:20'], '30:40')); groups++

assert.deepEqual(resolveTaskExecutionEnvironment({ cwd: '/local/project', saved: { kind: 'host' }, preferences: { mode: 'wsl', distribution: 'Ubuntu' } }), { kind: 'host' })
assert.throws(() => resolveTaskExecutionEnvironment({ cwd, saved: { kind: 'host' }, selection: { kind: 'wsl', distribution: 'Ubuntu' } }))
assert.throws(() => resolveTaskExecutionEnvironment({ cwd, selection: { kind: 'host' } })); groups++

const host: ExecutionProcessHost = { bindingForCwd: () => binding, executable: () => 'C:\\Windows\\System32\\wsl.exe', systemRoot: 'C:\\Windows',
  probe: args => { const input = args.at(-1); assert.equal(input, 'C:\\Temp\\index'); return Buffer.from('/mnt/c/Temp/index\nC:\\Temp\\index\n') } }
const launch = prepareExecutionProcess('git', ['-C', cwd, 'status'], { cwd, timeout: 3000, env: { GIT_INDEX_FILE: 'C:\\Temp\\index', GITLAB_HOST: 'gitlab.example', OPENAI_API_KEY: 'fixture-never-export' } }, host)
assert.equal(launch.file, 'C:\\Windows\\System32\\wsl.exe')
assert(launch.args.includes('/home/用户/project space'))
assert(launch.args.includes('GIT_INDEX_FILE=/mnt/c/Temp/index'))
assert(launch.args.includes('GITLAB_HOST=gitlab.example'))
assert(!launch.args.some(value => value.includes('fixture-never-export')))
assert.throws(() => prepareExecutionProcess('cmd.exe', ['/c', 'echo wrong'], { cwd }, host))
assert.throws(() => prepareExecutionProcess('git', ['-C', cwd.replace('Ubuntu', 'Debian'), 'status'], { cwd }, host))
assert.throws(() => prepareExecutionProcess('git', ['status'], { cwd, env: { GIT_INDEX_FILE: 'C:\\Temp\\index' } }, { ...host, probe: () => Buffer.from('/mnt/c/other\nC:\\Other\n') })); groups++

assert.deepEqual(parseGitAlternatePaths('"C:\\\\Temp\\\\semi;colon";"\\\\\\\\wsl.localhost\\\\Ubuntu\\\\home\\\\objects"'), ['C:\\Temp\\semi;colon', String.raw`\\wsl.localhost\Ubuntu\home\objects`])
assert.throws(() => parseGitAlternatePaths('"unterminated'))
const alternate = prepareExecutionProcess('git', ['status'], { cwd, env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(cwd) } }, host)
assert(alternate.args.includes('GIT_ALTERNATE_OBJECT_DIRECTORIES="/home/用户/project space"')); groups++
console.log(`PASS ${groups} WSL discovery/path/environment boundary groups; injected Windows process results only; no WSL/provider/service executed`)
