import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const executor = readFileSync(join(root, 'src/main/remote/executor.ts'), 'utf8')
const checks = [
  ['remote trigger has a fail-closed bypass guard', /routine\.permissionMode\s*===\s*['"]bypassPermissions['"]/u.test(executor)],
  ['bypass guard returns a failed command before execution', /bypassPermissions[\s\S]{0,240}finishCommandExecution\(commandId,\s*\{\s*status:\s*['"]failed['"]/u.test(executor)],
  ['routine execution remains after the guard', /bypassPermissions[\s\S]*?executeRoutine\(/u.test(executor)],
  ['guard explains local approval boundary', /requires local approval/u.test(executor)]
]
for (const [name, ok] of checks) {
  if (!ok) throw new Error(`remote policy-plane contract failed: ${name}`)
}
console.log(JSON.stringify({ suite: 'remote-policy-plane', passed: checks.length, checks: checks.map(([name]) => name) }, null, 2))
