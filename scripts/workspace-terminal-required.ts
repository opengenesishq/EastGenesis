import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TerminalManager } from '../src/main/terminal'
import { assertTerminalWindowOwner, canonicalTerminalDirectory, normalizeWorkspaceTerminalInput, terminalVisibleToWindow } from '../src/main/terminal-workspace-policy'

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'caogen-workspace-terminal-'))
  const manager = new TerminalManager()
  let output = '', exitOwned = false
  manager.subscribe((event) => {
    if (event.kind === 'output') output += event.data
    if (event.kind === 'exit') exitOwned ||= manager.get(event.id)?.ownerWebContentsId === 1001
  })
  try {
    assert.equal(canonicalTerminalDirectory(directory), directory.startsWith('/var/') ? `/private${directory}` : directory)
    assert.throws(() => normalizeWorkspaceTerminalInput({ cwd: directory, command: 'do-not-run' }), /命令/)
    assert.throws(() => normalizeWorkspaceTerminalInput({ cwd: directory, env: { SECRET: 'do-not-use' } }), /命令/)
    assert.throws(() => normalizeWorkspaceTerminalInput({ cwd: directory, cols: 2000 }), /尺寸/)
    assert.throws(() => normalizeWorkspaceTerminalInput({ cwd: directory, projectId: 'a', workspaceId: 'b' }), /项目/)
    const first = await manager.start({ cwd: directory, ownerWebContentsId: 1001, shell: '/bin/sh' })
    assert.equal(first.sessionId, undefined)
    assert.equal(first.ownerWebContentsId, 1001)
    const reused = await manager.start({ cwd: directory, ownerWebContentsId: 1001, shell: '/bin/sh' })
    assert.equal(reused.id, first.id)
    const other = await manager.start({ cwd: directory, ownerWebContentsId: 1002, shell: '/bin/sh' })
    assert.notEqual(other.id, first.id)
    assert.equal((await manager.start({ cwd: directory, ownerWebContentsId: 1001, shell: '/bin/sh' })).id, first.id)
    assert.equal(terminalVisibleToWindow(first, 1002), false)
    assert.equal(terminalVisibleToWindow(first, 1001), true)
    assert.throws(() => assertTerminalWindowOwner(first, 1002), /另一个窗口/)
    assert.doesNotThrow(() => assertTerminalWindowOwner(first, 1001))
    manager.write(first.id, "printf 'CAOGEN_WORKSPACE_TERMINAL_FIXTURE\\n'\n")
    const until = Date.now() + 5000
    while (!output.includes('CAOGEN_WORKSPACE_TERMINAL_FIXTURE') && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(output.includes('CAOGEN_WORKSPACE_TERMINAL_FIXTURE'))
    manager.close(first.id)
    const closedBy = Date.now() + 5000
    while (!exitOwned && Date.now() < closedBy) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(exitOwned, true)
    console.log('PASS: Real independent workspace shell, no chat Session identity, explicit input, owner-isolated reuse/output/control, directory/parameter validation and owned exit event.')
  } finally { manager.disposeAll(); rmSync(directory, { recursive: true, force: true }) }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
