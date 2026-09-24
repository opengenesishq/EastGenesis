import { app } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TerminalManager } from '../terminal'
import { getTrustedSshHostForTunnel } from './service'
import { RemoteSshTunnelManager } from './tunnel'

export function createRemoteSshTunnelManager(): RemoteSshTunnelManager {
  return new RemoteSshTunnelManager(join(app.getPath('userData'), 'ssh-tunnels'), getTrustedSshHostForTunnel, {
    async start(input) {
      const manager = new TerminalManager()
      const unsubscribe = manager.subscribe(event => {
        if (event.kind === 'output') input.onOutput(event.data)
        if (event.kind === 'error') input.onOutput(event.message)
        if (event.kind === 'exit') input.onExit(`SSH 进程已退出：${event.exit.exitCode ?? event.exit.signal ?? 'unknown'}`)
      })
      try {
        const terminal = await manager.start({ cwd: input.cwd, shell: '/usr/bin/ssh', args: input.args, requirePty: true,
          ownerWebContentsId: input.ownerId, sessionId: `ssh-tunnel:${randomUUID()}`, reuse: false, cols: 100, rows: 12 })
        return { write: data => manager.write(terminal.id, data), close: () => { unsubscribe(); manager.disposeAll() } }
      } catch (error) { unsubscribe(); manager.disposeAll(); throw error }
    }
  })
}
