import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import type {
  SemanticCompletionItem,
  SemanticCompletionResult,
  SemanticDefinitionLocation,
  SemanticDefinitionResult,
  SemanticDiagnostic,
  SemanticDiagnosticsResult,
  SemanticHoverResult,
  TypeScriptLanguageInput
} from '../shared/types'
import { buildMinimalSubprocessEnv } from './security/subprocess-environment'

const MAX_DOCUMENT_BYTES = 512_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_PROJECT_SERVERS = 4
const REQUEST_TIMEOUT_MS = 8_000
const DIAGNOSTIC_WAIT_MS = 1_500
const SUPPORTED_EXTENSIONS = new Map([
  ['.ts', 'typescript'],
  ['.tsx', 'typescriptreact'],
  ['.js', 'javascript'],
  ['.jsx', 'javascriptreact'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript']
])

interface Position {
  line: number
  character: number
}

interface Range {
  start: Position
  end: Position
}

interface LspDiagnostic {
  range?: Range
  severity?: number
  code?: string | number
  source?: string
  message?: string
}

interface LspLocation {
  uri?: string
  range?: Range
  targetUri?: string
  targetSelectionRange?: Range
}

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface DiagnosticWaiter {
  resolve: (diagnostics: LspDiagnostic[]) => void
  timer: NodeJS.Timeout
}

class TypeScriptLspClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, PendingRequest>()
  private readonly diagnostics = new Map<string, LspDiagnostic[]>()
  private readonly diagnosticWaiters = new Map<string, DiagnosticWaiter[]>()
  private readonly documentVersions = new Map<string, { version: number; content: string }>()
  private readonly ready: Promise<void>
  private nextId = 0
  private output = Buffer.alloc(0)
  private closed = false

  constructor(readonly root: string) {
    const require = createRequire(import.meta.url)
    const serverPackage = spawnablePath(require.resolve('typescript-language-server/package.json'))
    const serverPath = path.join(path.dirname(serverPackage), 'lib', 'cli.mjs')
    const tsserverPath = path.dirname(spawnablePath(require.resolve('typescript/lib/tsserver.js')))
    this.child = spawn(process.execPath, [serverPath, '--stdio', '--log-level', '1'], {
      cwd: root,
      env: buildMinimalSubprocessEnv({ ELECTRON_RUN_AS_NODE: '1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child.stdout.on('data', (chunk: Buffer) => this.consume(chunk))
    this.child.stderr.on('data', () => undefined)
    this.child.on('error', (error) => this.fail(error))
    this.child.on('exit', (code) => this.fail(new Error(`TypeScript language server exited (${code ?? 'null'})`)))
    this.ready = this.initialize(tsserverPath)
  }

  async syncDocument(uri: string, languageId: string, content: string): Promise<void> {
    await this.ready
    const current = this.documentVersions.get(uri)
    if (!current) {
      this.documentVersions.set(uri, { version: 1, content })
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text: content } })
      return
    }
    if (current.content === content) return
    const version = current.version + 1
    this.documentVersions.set(uri, { version, content })
    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text: content }]
    })
  }

  async request(method: string, params: unknown): Promise<unknown> {
    await this.ready
    return this.sendRequest(method, params)
  }

  async waitForDiagnostics(uri: string): Promise<LspDiagnostic[]> {
    await this.ready
    const key = diagnosticKey(uri)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.removeDiagnosticWaiter(key, waiter)
        resolve(this.diagnostics.get(key) ?? [])
      }, DIAGNOSTIC_WAIT_MS)
      const waiter: DiagnosticWaiter = { resolve, timer }
      this.diagnosticWaiters.set(key, [...(this.diagnosticWaiters.get(key) ?? []), waiter])
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    const exited = new Promise<void>((resolve) => this.child.once('exit', () => resolve()))
    try {
      await this.sendRequest('shutdown', null, 1_000)
      this.notify('exit')
    } catch {
      // The bounded kill below is the final cleanup path.
    }
    this.closed = true
    await Promise.race([exited, delay(500)])
    if (this.child.exitCode === null && !this.child.killed) this.child.kill()
    await Promise.race([exited, delay(500)])
    this.rejectPending(new Error('TypeScript language server closed'))
  }

  private async initialize(tsserverPath: string): Promise<void> {
    const rootUri = pathToFileURL(`${this.root}${path.sep}`).href
    await this.sendRequest('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) || 'workspace' }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: {
          completion: { completionItem: { snippetSupport: false } },
          definition: { linkSupport: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          publishDiagnostics: { relatedInformation: false }
        }
      },
      initializationOptions: {
        tsserver: { path: tsserverPath },
        preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true }
      },
      clientInfo: { name: 'CaoGen', version: '0.1.8' }
    })
    this.notify('initialized', {})
  }

  private sendRequest(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('TypeScript language server is closed'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`TypeScript language request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(method: string, params?: unknown): void {
    if (this.closed && method !== 'exit') return
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  private write(message: JsonRpcMessage): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    this.child.stdin.write(`Content-Length: ${body.byteLength}\r\n\r\n`, 'ascii')
    this.child.stdin.write(body)
  }

  private consume(chunk: Buffer): void {
    this.output = Buffer.concat([this.output, chunk])
    if (this.output.byteLength > MAX_RESPONSE_BYTES) {
      this.fail(new Error('TypeScript language server response exceeded the size limit'))
      return
    }
    while (true) {
      const headerEnd = this.output.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = this.output.subarray(0, headerEnd).toString('ascii')
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header)
      if (!match) {
        this.fail(new Error('TypeScript language server returned an invalid frame'))
        return
      }
      const length = Number(match[1])
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES) {
        this.fail(new Error('TypeScript language server returned an oversized frame'))
        return
      }
      const bodyStart = headerEnd + 4
      if (this.output.byteLength < bodyStart + length) return
      const body = this.output.subarray(bodyStart, bodyStart + length).toString('utf8')
      this.output = this.output.subarray(bodyStart + length)
      try {
        this.handle(JSON.parse(body) as JsonRpcMessage)
      } catch {
        this.fail(new Error('TypeScript language server returned invalid JSON'))
        return
      }
    }
  }

  private handle(message: JsonRpcMessage): void {
    if (message.method && message.id !== undefined && message.id !== null) {
      this.handleServerRequest(message)
      return
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      const params = asRecord(message.params)
      const uri = typeof params?.uri === 'string' ? params.uri : ''
      const diagnostics = Array.isArray(params?.diagnostics) ? params.diagnostics.filter(isRecord) as LspDiagnostic[] : []
      if (uri) {
        const key = diagnosticKey(uri)
        this.diagnostics.set(key, diagnostics)
        const waiters = this.diagnosticWaiters.get(key) ?? []
        this.diagnosticWaiters.delete(key)
        for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.resolve(diagnostics) }
      }
      return
    }
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) pending.reject(new Error(`TypeScript language server error: ${message.error.message ?? message.error.code ?? 'unknown'}`))
    else pending.resolve(message.result)
  }

  private handleServerRequest(message: JsonRpcMessage): void {
    const id = message.id as number | string
    let result: unknown = null
    if (message.method === 'workspace/configuration') {
      const items = asRecord(message.params)?.items
      result = Array.isArray(items) ? items.map(() => ({ tabSize: 2, insertSpaces: true })) : []
    } else if (message.method === 'workspace/workspaceFolders') {
      const uri = pathToFileURL(`${this.root}${path.sep}`).href
      result = [{ uri, name: path.basename(this.root) || 'workspace' }]
    }
    this.write({ jsonrpc: '2.0', id, result })
  }

  private removeDiagnosticWaiter(uri: string, waiter: DiagnosticWaiter): void {
    const next = (this.diagnosticWaiters.get(uri) ?? []).filter((item) => item !== waiter)
    if (next.length > 0) this.diagnosticWaiters.set(uri, next)
    else this.diagnosticWaiters.delete(uri)
  }

  private fail(error: Error): void {
    if (!this.closed) this.closed = true
    this.rejectPending(error)
    for (const waiters of this.diagnosticWaiters.values()) {
      for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.resolve([]) }
    }
    this.diagnosticWaiters.clear()
    if (!this.child.killed) this.child.kill()
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }
}

const clients = new Map<string, TypeScriptLspClient>()

export async function getTypeScriptCompletions(projectRoot: string, input: TypeScriptLanguageInput): Promise<SemanticCompletionResult> {
  try {
    const document = await prepareDocument(projectRoot, input)
    const raw = await document.client.request('textDocument/completion', { textDocument: { uri: document.uri }, position: document.position })
    const items = Array.isArray(raw) ? raw : Array.isArray(asRecord(raw)?.items) ? asRecord(raw)?.items as unknown[] : []
    return { ok: true, engine: 'typescript-lsp', items: items.slice(0, 100).map(completionView).filter(Boolean) as SemanticCompletionItem[] }
  } catch (error) {
    return { ok: false, engine: 'typescript-lsp', items: [], error: errorMessage(error) }
  }
}

export async function getTypeScriptHover(projectRoot: string, input: TypeScriptLanguageInput): Promise<SemanticHoverResult> {
  try {
    const document = await prepareDocument(projectRoot, input)
    const raw = asRecord(await document.client.request('textDocument/hover', { textDocument: { uri: document.uri }, position: document.position }))
    return { ok: true, engine: 'typescript-lsp', markdown: hoverText(raw?.contents) }
  } catch (error) {
    return { ok: false, engine: 'typescript-lsp', markdown: '', error: errorMessage(error) }
  }
}

export async function getTypeScriptDefinitions(projectRoot: string, input: TypeScriptLanguageInput): Promise<SemanticDefinitionResult> {
  try {
    const document = await prepareDocument(projectRoot, input)
    const source = await document.client.request('workspace/executeCommand', {
      command: '_typescript.goToSourceDefinition',
      arguments: [document.uri, document.position]
    }).catch(() => null)
    const raw = source || await document.client.request('textDocument/definition', {
      textDocument: { uri: document.uri }, position: document.position
    })
    const firstHop = Array.isArray(raw) ? raw : raw ? [raw] : []
    const followed: unknown[] = []
    for (const value of firstHop) {
      const target = definitionTarget(value)
      if (!target || target.uri !== document.uri || samePosition(target.position, document.position)) continue
      const next = await document.client.request('textDocument/definition', {
        textDocument: { uri: target.uri }, position: target.position
      }).catch(() => null)
      followed.push(...(Array.isArray(next) ? next : next ? [next] : []))
    }
    const preferred = followed.some((value) => definitionTarget(value)?.uri !== document.uri) ? followed : firstHop
    const entries = preferred.map(definitionView).filter(Boolean) as SemanticDefinitionLocation[]
    return { ok: true, engine: 'typescript-lsp', locations: deduplicateLocations(entries) }
  } catch (error) {
    return { ok: false, engine: 'typescript-lsp', locations: [], error: errorMessage(error) }
  }
}

export async function getTypeScriptDiagnostics(projectRoot: string, input: TypeScriptLanguageInput): Promise<SemanticDiagnosticsResult> {
  try {
    const document = await prepareDocument(projectRoot, input)
    const diagnostics = await document.client.waitForDiagnostics(document.uri)
    return { ok: true, engine: 'typescript-lsp', diagnostics: diagnostics.slice(0, 200).map((item) => diagnosticView(document.path, item)) }
  } catch (error) {
    return { ok: false, engine: 'typescript-lsp', diagnostics: [], error: errorMessage(error) }
  }
}

export async function disposeTypeScriptLanguageServers(): Promise<void> {
  const active = [...clients.values()]
  clients.clear()
  await Promise.all(active.map((client) => client.close().catch(() => undefined)))
}

async function prepareDocument(projectRoot: string, input: TypeScriptLanguageInput): Promise<{
  client: TypeScriptLspClient
  uri: string
  path: string
  position: Position
}> {
  const root = await realpath(projectRoot)
  const relativePath = normalizedRelativePath(input.path)
  const extension = path.extname(relativePath).toLocaleLowerCase()
  const languageId = SUPPORTED_EXTENSIONS.get(extension)
  if (!languageId) throw new Error('Language server does not support this file type')
  const bytes = Buffer.byteLength(input.content, 'utf8')
  if (bytes > MAX_DOCUMENT_BYTES) throw new Error(`Language document exceeds ${MAX_DOCUMENT_BYTES} bytes`)
  const fullPath = path.resolve(root, relativePath)
  if (!isInside(root, fullPath)) throw new Error('Project file path escapes the workspace')
  const fileInfo = await stat(fullPath)
  if (!fileInfo.isFile()) throw new Error('Language document is not a file')
  const realFile = await realpath(fullPath)
  if (!isInside(root, realFile)) throw new Error('Language document resolves outside the workspace')
  let client = clients.get(root)
  if (!client) {
    if (clients.size >= MAX_PROJECT_SERVERS) throw new Error('Language server project limit reached')
    client = new TypeScriptLspClient(root)
    clients.set(root, client)
  }
  const uri = pathToFileURL(realFile).href
  await client.syncDocument(uri, languageId, input.content)
  return {
    client,
    uri,
    path: path.relative(root, realFile).replace(/\\/g, '/'),
    position: boundedPosition(input.content, input.line, input.column)
  }
}

function completionView(value: unknown): SemanticCompletionItem | null {
  const item = asRecord(value)
  const label = typeof item?.label === 'string' ? item.label : ''
  if (!label) return null
  return {
    label,
    kind: completionKind(typeof item?.kind === 'number' ? item.kind : 0),
    detail: typeof item?.detail === 'string' ? item.detail.slice(0, 500) : '',
    insertText: typeof item?.insertText === 'string' ? item.insertText : label
  }
}

function definitionView(value: unknown): SemanticDefinitionLocation | null {
  const target = definitionTarget(value)
  if (!target || !target.uri.startsWith('file:')) return null
  const { uri, range } = target
  const filePath = fileURLToPath(uri)
  for (const [root] of clients) {
    if (!isInside(root, filePath)) continue
    return {
      path: path.relative(root, filePath).replace(/\\/g, '/'),
      line: range.start.line + 1,
      column: range.start.character + 1,
      endLine: range.end.line + 1,
      endColumn: range.end.character + 1
    }
  }
  return null
}

function definitionTarget(value: unknown): { uri: string; range: Range; position: Position } | null {
  const location = asRecord(value) as LspLocation | null
  const uri = location?.targetUri ?? location?.uri
  const range = location?.targetSelectionRange ?? location?.range
  if (!uri || !range) return null
  return { uri, range, position: range.start }
}

function samePosition(left: Position, right: Position): boolean {
  return left.line === right.line && left.character === right.character
}

function spawnablePath(resolvedPath: string): string {
  const marker = `${path.sep}app.asar${path.sep}`
  if (!resolvedPath.includes(marker)) return resolvedPath
  const unpacked = resolvedPath.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`)
  return existsSync(unpacked) ? unpacked : resolvedPath
}

function diagnosticView(relativePath: string, value: LspDiagnostic): SemanticDiagnostic {
  const range = value.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
  return {
    path: relativePath,
    line: range.start.line + 1,
    column: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
    severity: value.severity === 1 ? 'error' : value.severity === 2 ? 'warning' : 'info',
    source: value.source || 'typescript-lsp',
    code: value.code === undefined ? '' : String(value.code),
    message: typeof value.message === 'string' ? value.message.slice(0, 2_000) : 'TypeScript diagnostic'
  }
}

function hoverText(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 4_000)
  if (Array.isArray(value)) return value.map(hoverText).filter(Boolean).join('\n\n').slice(0, 4_000)
  const record = asRecord(value)
  if (!record) return ''
  return typeof record.value === 'string' ? record.value.slice(0, 4_000) : ''
}

function boundedPosition(content: string, lineValue: number, columnValue: number): Position {
  const lines = content.split('\n')
  const line = Math.max(0, Math.min(Math.floor(lineValue) - 1, lines.length - 1))
  const character = Math.max(0, Math.min(Math.floor(columnValue) - 1, lines[line]?.length ?? 0))
  return { line, character }
}

function completionKind(kind: number): string {
  return ({ 2: 'method', 3: 'function', 4: 'constructor', 5: 'field', 6: 'variable', 7: 'class', 8: 'interface', 9: 'module', 10: 'property', 13: 'enum', 14: 'keyword', 20: 'constant', 21: 'struct', 22: 'event', 23: 'operator', 25: 'type' } as Record<number, string>)[kind] ?? 'symbol'
}

function deduplicateLocations(locations: SemanticDefinitionLocation[]): SemanticDefinitionLocation[] {
  return [...new Map(locations.map((item) => [`${item.path}:${item.line}:${item.column}`, item])).values()]
}

function normalizedRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').trim()
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..') || normalized.includes('\0')) {
    throw new Error('Project file path is invalid')
  }
  return normalized
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function diagnosticKey(uri: string): string {
  if (!uri.startsWith('file:')) return uri
  try {
    const filePath = path.resolve(fileURLToPath(uri))
    return process.platform === 'win32' ? filePath.toLocaleLowerCase() : filePath
  } catch {
    return uri
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
