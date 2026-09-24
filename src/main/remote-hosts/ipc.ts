import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { assertTrustedWorkflowLedgerSender } from '../ipc/workflow-ledger-handlers'
import { protectedStorage } from '../security/protected-storage-runtime'
import { RemoteHostService } from './service'
import { remoteHostHttpsTransport } from './transport'
import { object, text } from './validation'
import type { RemoteHostApi } from '../../shared/remote-host-types'
import { createRemoteSshTunnelManager } from '../ssh/tunnel-runtime'
import { desktopWindowRole } from '../desktop-window-registry'
import { installRemoteHostService } from './runtime'

export function registerRemoteHostsIpc(): void {
  const service = new RemoteHostService(app.getPath('userData'), protectedStorage, remoteHostHttpsTransport, Date.now, createRemoteSshTunnelManager())
  const releaseService = installRemoteHostService(service)
  const owners = new Set<number>()
  app.once('before-quit', () => { service.dispose(); releaseService() })
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    list: () => service.listRemoteHosts(), inspect: value => service.inspectRemoteHostPairing(text(value, 2048)),
    pair: value => service.pairRemoteHost(object(value) as unknown as Parameters<RemoteHostApi['pairRemoteHost']>[0]),
    tasks: id => service.readRemoteHostTasks(text(id)),
    command: value => service.sendRemoteHostCommand(object(value) as unknown as Parameters<RemoteHostApi['sendRemoteHostCommand']>[0]),
    receipt: (id, commandId) => service.reconcileRemoteHostCommand(text(id), text(commandId)),
    'request-receipt': (id, requestId) => service.findRemoteHostCommandByRequestId(text(id), text(requestId, 160)),
    'workspace-describe': (id, workItemId) => service.describeRemoteWorkspace(text(id), text(workItemId)),
    'workspace-read': value => service.readRemoteWorkspace(object(value) as unknown as Parameters<RemoteHostApi['readRemoteWorkspace']>[0]),
    'approval-decide': value => service.decideRemoteHostApproval(object(value) as unknown as Parameters<RemoteHostApi['decideRemoteHostApproval']>[0]),
    'approval-receipt': (id, requestId) => service.reconcileRemoteHostApproval(text(id), text(requestId)),
    renew: id => service.renewRemoteHost(text(id)),
    revoke: id => service.revokeRemoteHost(text(id)), forget: id => service.forgetRemoteHost(text(id))
  }
  for (const action of [...Object.keys(methods), 'tunnels', 'tunnel-start', 'tunnel-input', 'tunnel-close', 'workspace-save']) ipcMain.handle(`remote-hosts:${action}`, (event, ...args: unknown[]) => {
    assertTrustedWorkflowLedgerSender(event)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed() && desktopWindowRole(win) === 'task' && action === 'list') return service.listRemoteHosts()
    if (!win || win.isDestroyed() || desktopWindowRole(win) !== 'main') throw new Error('请在主工作台管理远端主机。')
    if (!owners.has(event.sender.id)) {
      owners.add(event.sender.id)
      event.sender.once('destroyed', () => { owners.delete(event.sender.id); service.invalidatePairingPreviews() })
      event.sender.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) service.invalidatePairingPreviews() })
    }
    if (action === 'tunnels') return service.listRemoteSshTunnels(event.sender.id)
    if (action === 'tunnel-start') return service.startRemoteHostSshTunnel(object(args[0]) as unknown as Parameters<RemoteHostApi['startRemoteHostSshTunnel']>[0], event.sender.id)
    if (action === 'tunnel-input') return service.writeRemoteSshTunnelInput(text(args[0]), args[1] as string, event.sender.id)
    if (action === 'tunnel-close') return service.closeRemoteSshTunnel(text(args[0]), event.sender.id)
    if (action === 'workspace-save') return service.saveRemoteWorkspaceFile(object(args[0]) as unknown as Parameters<RemoteHostApi['saveRemoteWorkspaceFile']>[0], async suggested => {
      const result = await dialog.showSaveDialog(win, { title: '另存远端任务文件', defaultPath: suggested, properties: ['showOverwriteConfirmation', 'createDirectory'] })
      if (win.isDestroyed() || event.sender.isDestroyed()) throw new Error('窗口已关闭，另存已取消。')
      return result.canceled ? undefined : result.filePath
    })
    if (action === 'inspect') return service.inspectRemoteHostPairing(text(args[0], 2048), args[1] === undefined ? undefined : text(args[1]), event.sender.id)
    return methods[action](...args)
  })
}
