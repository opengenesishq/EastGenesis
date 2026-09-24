import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Module } from 'node:module'
import { build } from 'esbuild'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-pr-draft-')))
const data = join(root, 'data'), repo = join(root, 'repo'), worktree = join(root, 'worktree'), bin = join(root, 'bin')
for (const path of [data, repo, bin]) mkdirSync(path)
const oldPath = process.env.PATH, oldFetch = globalThis.fetch
globalThis.__prDraftRoot = data
globalThis.__prGitPreferences = { branchPrefix: 'team/new', pullRequestTitleTemplate: '{title}', pullRequestBodyTemplate: '{summary}' }
globalThis.fetch = async () => { throw new Error('Network forbidden in local PR preparation check') }
// Every subprocess uses a temporary Git wrapper which refuses all remote operations.
const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim()
writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor arg in "$@"; do\n case "$arg" in fetch|push|pull|ls-remote|clone) echo 'Remote Git forbidden in local check' >&2; exit 97;; esac\ndone\nexec '${realGit.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 })
process.env.PATH = `${bin}:${oldPath}`
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
}).trimEnd()
let checks = 0
const pass = label => { checks++; console.log(`PASS ${label}`) }
try {
  const built = await build({ stdin: { contents: `export * from './src/main/git/worktree-pr-draft-service'; export * from './src/main/git/worktree-pr-draft-store'; export * from './src/main/git/worktree-pr-preview'; export * from './src/main/managed-worktree-lifecycle'; export * from './src/shared/desktop-git-preferences';`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    plugins: [{ name: 'local-runtime', setup(builder) {
      builder.onResolve({ filter: /^electron$|(?:^|\/)settings$/ }, args => ({ path: args.path === 'electron' ? 'electron' : 'settings', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'electron'
        ? 'module.exports = { app: { getPath: () => globalThis.__prDraftRoot } }'
        : 'module.exports = { getSettings: () => ({gitPreferences: globalThis.__prGitPreferences}) }', loader: 'js' }))
    } }] })
  const filename = resolve('scripts/.worktree-pr-draft-fixture.cjs'), module = new Module(filename)
  module.filename = filename; module.paths = Module._nodeModulePaths(dirname(filename)); module._compile(built.outputFiles[0].text, filename)
  const api = module.exports
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Local Fixture'); git(repo, 'config', 'user.email', 'fixture@invalid.test')
  writeFileSync(join(repo, 'report.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base')
  const baseSha = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'worktree', 'add', '-b', 'legacy/existing', worktree)
  writeFileSync(join(worktree, 'report.txt'), 'base\ncommitted result\n'); git(worktree, 'add', '.'); git(worktree, 'commit', '-m', 'Add report result')
  const headSha = git(worktree, 'rev-parse', 'HEAD')
  writeFileSync(join(worktree, 'report.txt'), 'base\ncommitted result\nLOCAL PENDING\n')
  writeFileSync(join(worktree, 'notes.txt'), 'UNTRACKED PRIVATE NOTES\n')
  const record = { sessionId: 'fixture-session', repoRoot: repo, sourceCwd: repo, worktreePath: worktree, cwd: worktree,
    branch: 'legacy/existing', baseSha, baseBranch: 'main', state: 'active', createdAt: 1, updatedAt: 1 }
  const meta = { id: record.sessionId, title: 'Editable report', status: 'idle', isolated: true, createdAt: 1, cwd: worktree,
    workspaceId: 'fixture-workspace', goalId: 'fixture-goal', workItemId: 'fixture-item' }
  mkdirSync(join(data, 'worktrees')); writeFileSync(join(data, 'worktrees', 'index.json'), JSON.stringify({ schemaVersion: 1, records: [record] }))
  const newPlan = api.prepareManagedWorktreeCreateEffect({ sessionId: 'new-task', cwd: repo, isolated: true })
  assert.equal(newPlan.plan.record.branch, 'team/new/new-task')
  const oldPlan = api.prepareManagedWorktreeCreateEffect({ sessionId: record.sessionId, cwd: repo, isolated: true })
  assert.equal(oldPlan.existing, true); assert.equal(oldPlan.record.branch, 'legacy/existing')
  pass('S20 branch prefix applies only to new managed Worktrees')

  let effectsRead = 0, available = false, existingEffect
  const runtime = { meta: () => meta, record: () => record,
    defaults: (currentMeta, snapshot) => { const p = api.normalizeDesktopGitPreferences(globalThis.__prGitPreferences)
      const context = { title: currentMeta.title, branch: snapshot.binding.branch, baseBranch: snapshot.baseBranch, summary: snapshot.commits.map(item => item.subject).join('\n') }
      return { title: api.expandGitTextTemplate(p.pullRequestTitleTemplate, context), body: api.expandGitTextTemplate(p.pullRequestBodyTemplate, context) } },
    capability: () => ({ available, tool: 'gh', provider: 'github', message: available ? undefined : 'fixture has no remote' }),
    effect: async () => { effectsRead++; return existingEffect } }
  let service = new api.WorktreePullRequestDraftService(data, runtime)
  let prepared = service.prepare(meta.id)
  assert.equal(prepared.snapshot.headSha, headSha); assert.equal(prepared.snapshot.baseSha, baseSha)
  assert.equal(prepared.snapshot.commitCount, 1); assert(prepared.snapshot.diff.includes('committed result'))
  assert(!prepared.snapshot.diff.includes('LOCAL PENDING')); assert(!prepared.snapshot.diff.includes('UNTRACKED PRIVATE NOTES'))
  assert.equal(prepared.snapshot.dirty.unstaged, 1); assert.equal(prepared.snapshot.dirty.untracked, 1)
  assert.equal(prepared.capability.authentication, 'not_checked'); assert.equal(effectsRead, 0)
  let save = { requestId: 'save-one', expectedRevision: 0, snapshotDigest: prepared.snapshot.digest, title: 'Report PR', body: 'Reviewed description', baseBranch: 'main' }
  let draft = await service.save(meta.id, save)
  assert.deepEqual(await service.save(meta.id, save), JSON.parse(JSON.stringify(draft)))
  assert.equal(effectsRead, 0)
  const draftFile = join(data, 'private/worktree-pr-drafts', readdirSync(join(data, 'private/worktree-pr-drafts'))[0])
  assert.equal(statSync(draftFile).mode & 0o777, 0o600)
  service = new api.WorktreePullRequestDraftService(data, runtime)
  globalThis.__prGitPreferences = { ...globalThis.__prGitPreferences, pullRequestTitleTemplate: 'CHANGED DEFAULT' }
  assert.equal(service.prepare(meta.id).defaults.title, 'Report PR')
  await assert.rejects(service.save(meta.id, { ...save, title: 'changed with same request' }), /相同保存标识/)
  await assert.rejects(service.save(meta.id, { ...save, requestId: 'stale-version' }), /版本/)
  pass('local preview excludes dirty files; offline draft persists privately with retry/version guards and frozen defaults')

  git(repo, 'remote', 'add', 'origin', 'https://fixture-user:fixture-secret@github.com/fixture/preview.git?credential=fixture-token')
  prepared = service.prepare(meta.id); assert.equal(prepared.draftStale, true)
  assert(!JSON.stringify(prepared).includes('fixture-secret')); assert(!JSON.stringify(prepared).includes('fixture-token'))
  available = true
  save = { ...save, requestId: 'save-remote', draftId: draft.id, expectedRevision: draft.revision, snapshotDigest: prepared.snapshot.digest }
  draft = await service.save(meta.id, save)
  assert(!readFileSync(draftFile, 'utf8').includes('fixture-secret'))
  const input = item => ({ draftId: item.id, expectedRevision: item.revision, snapshotDigest: item.snapshot.digest })
  writeFileSync(join(worktree, 'added-pending.txt'), 'new pending path\n')
  await assert.rejects(service.freezeSubmission(meta.id, input(draft)), /状态已变化/)
  rmSync(join(worktree, 'added-pending.txt'))
  const alternate = service.prepare(meta.id, { baseBranch: 'missing-local-base' })
  assert(alternate.snapshot.baseUnavailable)
  await assert.rejects(service.save(meta.id, { ...save, requestId: 'wrong-digest', expectedRevision: draft.revision, baseBranch: 'missing-local-base' }), /目标分支已变化/)
  pass('remote credentials are excluded; changed worktree state and base snapshot are refused')

  draft = await service.freezeSubmission(meta.id, input(draft))
  const pushId = draft.submission.pushOperationId
  assert.equal((await service.freezeSubmission(meta.id, input(draft))).submission.pushOperationId, pushId)
  draft = await service.markPhase(meta.id, input(draft), 'push')
  service.assertCurrentDraft(meta.id, input(draft), 'push')
  await service.recordOutcome(meta.id, input(draft), 'push', { status: 'waiting_reconciliation', effectId: 'effect-original', error: 'ack unknown' })
  assert.equal((await service.freezeSubmission(meta.id, input(draft))).submission.status, 'needs_reconciliation')
  await assert.rejects(service.save(meta.id, { ...save, requestId: 'while-unknown', expectedRevision: draft.revision }), /待核对/)
  existingEffect = { id: 'effect-original', status: 'confirmed', target: { kind: 'git_push', repoRoot: worktree, branch: record.branch,
    intendedSha: headSha, remote: 'origin', pushUrlDigest: draft.snapshot.remote.pushUrlDigest } }
  draft = await service.freezeSubmission(meta.id, input(draft))
  assert.equal(draft.submission.status, 'pushed'); assert.equal(draft.submission.pushOperationId, pushId)
  draft = await service.markPhase(meta.id, input(draft), 'pr')
  const prEffect = { id: 'pr-original', status: 'confirmed', target: { kind: 'pull_request_create', repoRoot: worktree,
    repoRootIdentity: draft.snapshot.binding.worktreeIdentity, sourceBranch: record.branch, sourceSha: headSha, baseBranch: 'main',
    remote: 'origin', remoteUrlDigest: draft.snapshot.remote.urlDigest, titleDigest: draft.titleDigest, bodyDigest: draft.bodyDigest } }
  assert(api.effectMatchesDraft(prEffect, draft, 'pr'))
  assert(!api.effectMatchesDraft({ ...prEffect, target: { ...prEffect.target, repoRootIdentity: { device: 'wrong', inode: 'wrong' } } }, draft, 'pr'))
  assert(!api.effectMatchesDraft({ ...prEffect, target: { ...prEffect.target, titleDigest: 'wrong' } }, draft, 'pr'))
  existingEffect = prEffect
  draft = await service.freezeSubmission(meta.id, input(draft))
  assert.equal(draft.submission.status, 'completed')
  assert.equal((await service.confirmedPrEffect(meta.id, input(draft))).id, prEffect.id)
  pass('unknown push cannot replay; original confirmed ledger resumes PR phase with matching identity and frozen text')

  prepared = service.prepare(meta.id)
  draft = await service.save(meta.id, { ...save, requestId: 'editable-again', expectedRevision: draft.revision, snapshotDigest: prepared.snapshot.digest })
  draft = await service.freezeSubmission(meta.id, input(draft))
  const abandonedRevision = draft.revision
  const newer = await service.save(meta.id, { ...save, requestId: 'replace-prepared', expectedRevision: draft.revision, snapshotDigest: draft.snapshot.digest, body: 'New user-reviewed body' })
  await assert.rejects(service.freezeSubmission(meta.id, input(draft)), /原提交已停止/)
  const retained = new api.WorktreePullRequestDraftStore(data).read(meta.id)
  assert.equal(retained.find(item => item.revision === abandonedRevision).submission.status, 'failed')
  assert(retained.find(item => item.submission?.status === 'completed'))
  draft = await service.freezeSubmission(meta.id, input(newer)); await service.markPhase(meta.id, input(draft), 'push')
  writeFileSync(join(worktree, 'later.txt'), 'later commit\n'); git(worktree, 'add', 'later.txt'); git(worktree, 'commit', '-m', 'later')
  assert.throws(() => service.assertCurrentDraft(meta.id, input(draft), 'push'), /状态发生变化/)
  meta.createdAt = 2
  await assert.rejects(service.freezeSubmission(meta.id, input(draft)), /原任务身份/)
  meta.createdAt = 1; record.branch = 'wrong-branch'
  assert.throws(() => service.prepare(meta.id), /branch|分支/)
  pass('safe prepared drafts can be superseded without deleting receipts; execution-time HEAD and rebound task/worktree are rejected')
  console.log(`PASS ${checks} focused groups; only temporary local Git, no Provider calls, no fetch, push, PR creation or comments`)
} finally {
  process.env.PATH = oldPath; globalThis.fetch = oldFetch
  delete globalThis.__prDraftRoot; delete globalThis.__prGitPreferences
  rmSync(root, { recursive: true, force: true })
}
