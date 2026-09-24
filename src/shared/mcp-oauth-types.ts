export interface McpOAuthBinding {
  registryItemKey: string
  contentDigest: string
  capabilityDigest: string
  serverId: string
}

export interface McpOAuthPreparation {
  id: string
  resource: string
  issuer: string
  scopes: string[]
  dynamicRegistration: boolean
  expiresAt: number
}

export interface McpOAuthState {
  status: 'disconnected' | 'unsupported' | 'ready' | 'authorizing' | 'connected' | 'authorization_required' | 'error'
  storage?: 'encrypted' | 'session'
  resource?: string
  issuer?: string
  scopes?: string[]
  expiresAt?: number
  preparation?: McpOAuthPreparation
  message?: string
}

export interface McpOAuthConnectOptions {
  preparationId: string
  clientId?: string
  callbackPort?: number
  scopes?: string[]
}

export interface McpOAuthApi {
  getMcpOAuthState(binding: McpOAuthBinding, sessionId?: string): Promise<McpOAuthState>
  prepareMcpOAuth(binding: McpOAuthBinding, sessionId?: string): Promise<McpOAuthState>
  connectMcpOAuth(binding: McpOAuthBinding, options: McpOAuthConnectOptions, sessionId?: string): Promise<McpOAuthState>
  cancelMcpOAuth(binding: McpOAuthBinding, sessionId?: string): Promise<McpOAuthState>
  disconnectMcpOAuth(binding: McpOAuthBinding, revokeRemote: boolean, sessionId?: string): Promise<McpOAuthState>
}
