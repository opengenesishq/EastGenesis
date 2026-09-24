import { ipcRenderer } from 'electron'
import type { McpOAuthApi } from '../shared/mcp-oauth-types'

export const mcpOAuthApi: McpOAuthApi = {
  getMcpOAuthState: (binding, session) => ipcRenderer.invoke('mcp-oauth:get', binding, session),
  prepareMcpOAuth: (binding, session) => ipcRenderer.invoke('mcp-oauth:prepare', binding, session),
  connectMcpOAuth: (binding, options, session) => ipcRenderer.invoke('mcp-oauth:connect', binding, options, session),
  cancelMcpOAuth: (binding, session) => ipcRenderer.invoke('mcp-oauth:cancel', binding, session),
  disconnectMcpOAuth: (binding, remote, session) => ipcRenderer.invoke('mcp-oauth:disconnect', binding, remote, session)
}
