import { lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_USER_RULE_BYTES = 128 * 1024

export function buildUserRulesSystemAppendSync(home = homedir()): string {
  const path = join(home, '.caogen', 'rules.md')
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_USER_RULE_BYTES) return ''
    const content = readFileSync(path, 'utf8').trim()
    return content ? `# CaoGen User Rules\n\n${content}` : ''
  } catch {
    return ''
  }
}
