import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, win32 } from 'node:path'
import { execFileSyncInExecutionEnvironment as execGit, execFileInExecutionEnvironment, spawnSyncInExecutionEnvironment, prepareExecutionProcess, convertExecutionOutput } from '../src/main/wsl/process'
import { assertManagedWorktreeExecutionPath, wslManagedWorktreePath } from '../src/main/git/wsl-worktree-path'
import { planDiscardWorkspaceHunk } from '../src/main/git/worktree-hunk-effect'
import { gitCliAvailable, gitCliOverride } from '../src/main/git/cli-override'
import type { WslExecutionBinding } from '../src/shared/wsl-types'

async function main(): Promise<void> {
  let groups = 0
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-wsl-git-required-')))
  const fixtureEnv = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  const git = (cwd: string, args: string[]) => execGit('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: fixtureEnv, encoding: 'utf8', stdio: 'pipe' }).trim()
  try {
    const repo = join(root, 'repo'); mkdirSync(repo)
    git(repo, ['init', '--initial-branch=main'])
    writeFileSync(join(repo, 'note.txt'), 'before\n')
    git(repo, ['add', 'note.txt'])
    git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture only'])
    assert.equal(git(repo, ['rev-parse', '--show-toplevel']), repo)
    assert.equal(spawnSyncInExecutionEnvironment('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).stdout.trim(), repo)
    await new Promise<void>((resolve, reject) => execFileInExecutionEnvironment('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }, (error, stdout) => {
      if (error) return reject(error)
      try { assert.equal(stdout.trim(), repo); resolve() } catch (failure) { reject(failure) }
    }))
    groups++

    const wslRepo = String.raw`\\wsl.localhost\Ubuntu\home\fixture\repo`
    const common = win32.join(wslRepo, '.git')
    const target = wslManagedWorktreePath(wslRepo, common, 'fixture-task')!
    assert.equal(target, win32.join(common, 'caogen-workspaces', 'fixture-task'))
    assertManagedWorktreeExecutionPath(wslRepo, common, target, 'fixture-task')
    assert.throws(() => assertManagedWorktreeExecutionPath(wslRepo, common, String.raw`C:\Users\fixture\worktrees\task`, 'fixture-task'))
    assert.throws(() => assertManagedWorktreeExecutionPath(repo, join(repo, '.git'), target, 'fixture-task'))
    assert.throws(() => assertManagedWorktreeExecutionPath(wslRepo, common, target.replace('Ubuntu', 'Debian'), 'fixture-task'))
    assert.throws(() => wslManagedWorktreePath(wslRepo, String.raw`\\wsl.localhost\Ubuntu\home\other\.git`, 'fixture-task'))
    assert.throws(() => wslManagedWorktreePath(wslRepo, common, '../escape'))
    groups++

    const binding: WslExecutionBinding = { kind: 'wsl', schemaVersion: 1, distribution: 'Ubuntu', hostCwd: wslRepo,
      guestCwd: '/home/fixture/repo', guestRootIdentity: '1:2', hostRootIdentity: '3:4' }
    const porcelain = 'worktree /home/fixture/repo\0HEAD abc\0branch refs/heads/main\0\0worktree /home/fixture/repo/.git/caogen-workspaces/fixture-task\0HEAD abc\0\0'
    const mapped = String(convertExecutionOutput(porcelain, ['worktree', 'list', '--porcelain', '-z'], binding))
    assert(mapped.includes(`worktree ${wslRepo}\0`))
    assert(mapped.includes(`worktree ${target}\0`))
    assert.equal(convertExecutionOutput('diff --git a/a b/a\n+/home/fixture/repo\n', ['diff'], binding), 'diff --git a/a b/a\n+/home/fixture/repo\n')
    groups++

    assert.throws(() => prepareExecutionProcess('git', ['status'], { cwd: wslRepo }), /绑定/)
    assert.throws(() => prepareExecutionProcess('git', ['-C', wslRepo, 'status']), /绑定/)
    assert.equal(gitCliAvailable('gh', 500, wslRepo), false)
    const previousOverride = process.env.CAOGEN_GH_EXECUTABLE
    try { process.env.CAOGEN_GH_EXECUTABLE = process.execPath; assert.equal(gitCliOverride('gh', wslRepo), undefined) }
    finally { if (previousOverride === undefined) delete process.env.CAOGEN_GH_EXECUTABLE; else process.env.CAOGEN_GH_EXECUTABLE = previousOverride }
    groups++

    const worktree = join(repo, '.git', 'caogen-workspaces', 'fixture-task')
    git(repo, ['worktree', 'add', '--no-track', '-b', 'caogen/fixture-task', worktree, 'HEAD'])
    assert.equal(git(repo, ['status', '--porcelain']), '')
    assert.equal(git(worktree, ['rev-parse', '--show-toplevel']), worktree)
    assert.equal(realpathSync(resolve(worktree, git(worktree, ['rev-parse', '--git-common-dir']))), join(repo, '.git'))
    git(repo, ['worktree', 'remove', worktree]); groups++

    writeFileSync(join(repo, 'note.txt'), 'after\n')
    const patch = git(repo, ['diff', '--', 'note.txt'])
    const planned = planDiscardWorkspaceHunk(repo, 'note.txt', patch)
    assert.equal(planned.ok, true, planned.ok ? undefined : planned.error)
    if (planned.ok) assert.equal(planned.plan.expectedContent?.toString(), 'before\n')
    assert.equal(readFileSync(join(repo, 'note.txt'), 'utf8'), 'after\n')
    groups++
    console.log(`PASS ${groups} WSL Git integration fixture groups; temporary repositories only, no remote/provider requests; Windows WSL runtime not exercised`)
  } finally { rmSync(root, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
