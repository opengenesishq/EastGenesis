import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { normalizeDesktopGitPreferences, expandGitTextTemplate, normalizeGitBranchPrefix } from '../src/shared/desktop-git-preferences'
let passed = 0
function check(name: string, run: () => void): void { run(); passed++; console.log(`PASS ${name}`) }
check('Branch defaults preserve existing convention and accepted prefixes are valid Git refs', () => {
  assert.equal(normalizeDesktopGitPreferences(undefined).branchPrefix, 'caogen')
  for (const input of ['caogen', 'team/feature', 'codex/', '任务']) {
    const prefix = normalizeGitBranchPrefix(input)
    execFileSync('git', ['check-ref-format', '--branch', `${prefix}/sample`], { stdio: 'pipe' })
  }
  for (const value of ['', '-option', '../escape', 'a//b', 'a.lock', '/leading', 'a b', 'a@{b', 'a\\b', 'a\nb', 'a?b']) assert.throws(() => normalizeGitBranchPrefix(value))
})
check('Templates substitute literal text once, and reject unsupported fields or excessive content', () => {
  const config = normalizeDesktopGitPreferences({ commitTemplate: '{title}\n\n{summary}' })
  const result = expandGitTextTemplate(config.commitTemplate, { title: '`not-a-command` $(literal)', summary: '{branch}', branch: 'must-not-recurse', baseBranch: 'main' })
  assert.equal(result, '`not-a-command` $(literal)\n\n{branch}')
  assert.throws(() => normalizeDesktopGitPreferences({ pullRequestTitleTemplate: 'a\nb' }))
  assert.throws(() => normalizeDesktopGitPreferences({ commitTemplate: '{unknownField}' }))
  assert.throws(() => normalizeDesktopGitPreferences({ pullRequestBodyTemplate: 'x'.repeat(12001) }))
  assert.throws(() => normalizeDesktopGitPreferences({ branchPrefix: 12 }))
})
console.log(JSON.stringify({ passed, modelCalls: 0, repositoryMutations: 0 }))
