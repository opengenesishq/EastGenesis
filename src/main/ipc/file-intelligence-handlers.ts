import { assertTaskExecutionEnvironment } from '../wsl/binding'
import { ipcMain } from 'electron'
import type { TypeScriptLanguageInput } from '../../shared/types'
import { listProjectFiles, readTextFile, searchProjectText } from '../fileOps'
import { collectProjectDiagnostics } from '../projectDiagnostics'
import { resolveProjectDefinition, searchProjectSymbols } from '../projectLanguageIntelligence'
import { sessionManager } from '../sessionManager'
import {
  getTypeScriptCompletions,
  getTypeScriptDefinitions,
  getTypeScriptDiagnostics,
  getTypeScriptHover
} from '../typescriptLanguageServer'

type FileIntelligenceOperation = keyof typeof FILE_INTELLIGENCE_HANDLERS
type FileIntelligenceHandler = (cwd: string, args: unknown[]) => unknown

const FILE_INTELLIGENCE_HANDLERS: Record<string, FileIntelligenceHandler> = {
  list: (cwd) => listProjectFiles(cwd),
  search: (cwd, [query]) => searchProjectText(cwd, stringValue(query)),
  diagnostics: (cwd) => collectProjectDiagnostics(cwd),
  symbols: (cwd, [query, limit]) => searchProjectSymbols(
    cwd,
    stringValue(query),
    typeof limit === 'number' ? limit : undefined
  ),
  definition: (cwd, [relPath, symbol]) => resolveProjectDefinition(
    cwd,
    stringValue(relPath),
    stringValue(symbol)
  ),
  typescriptCompletions: (cwd, [value]) => withTypeScriptInput(value,
    (input) => getTypeScriptCompletions(cwd, input),
    Promise.resolve({ ok: false, engine: 'typescript-lsp', items: [], error: '语言请求无效' })),
  typescriptHover: (cwd, [value]) => withTypeScriptInput(value,
    (input) => getTypeScriptHover(cwd, input),
    Promise.resolve({ ok: false, engine: 'typescript-lsp', markdown: '', error: '语言请求无效' })),
  typescriptDefinitions: (cwd, [value]) => withTypeScriptInput(value,
    (input) => getTypeScriptDefinitions(cwd, input),
    Promise.resolve({ ok: false, engine: 'typescript-lsp', locations: [], error: '语言请求无效' })),
  typescriptDiagnostics: (cwd, [value]) => withTypeScriptInput(value,
    (input) => getTypeScriptDiagnostics(cwd, input),
    Promise.resolve({ ok: false, engine: 'typescript-lsp', diagnostics: [], error: '语言请求无效' })),
  read: (cwd, [relPath]) => readTextFile(cwd, stringValue(relPath))
}

const MISSING_SESSION_RESULTS: Record<FileIntelligenceOperation, unknown> = {
  list: { ok: false, entries: [], error: '会话不存在' },
  search: { ok: false, matches: [], error: '会话不存在' },
  diagnostics: {
    ok: false,
    diagnostics: [],
    analyzedFiles: 0,
    supportedFiles: 0,
    truncated: false,
    error: '会话不存在'
  },
  symbols: { ok: false, symbols: [], error: '会话不存在' },
  definition: { ok: false, symbols: [], error: '会话不存在' },
  typescriptCompletions: { ok: false, engine: 'typescript-lsp', items: [], error: '会话不存在' },
  typescriptHover: { ok: false, engine: 'typescript-lsp', markdown: '', error: '会话不存在' },
  typescriptDefinitions: { ok: false, engine: 'typescript-lsp', locations: [], error: '会话不存在' },
  typescriptDiagnostics: { ok: false, engine: 'typescript-lsp', diagnostics: [], error: '会话不存在' },
  read: { ok: false, error: '会话不存在' }
}

export function registerFileIntelligenceIpc(): void {
  ipcMain.handle('files:intelligence', (_event, operation: unknown, sessionId: unknown, ...args: unknown[]) => {
    const normalizedOperation = typeof operation === 'string' ? operation : ''
    const handler = FILE_INTELLIGENCE_HANDLERS[normalizedOperation]
    if (!handler) throw new Error(`不支持的文件智能操作: ${normalizedOperation || 'missing'}`)
    const meta = typeof sessionId === 'string' ? sessionManager.get(sessionId)?.meta : undefined
    if (meta) assertTaskExecutionEnvironment(meta)
    const cwd = meta?.cwd
    if (!cwd) return MISSING_SESSION_RESULTS[normalizedOperation as FileIntelligenceOperation]
    return handler(cwd, args)
  })
}

function typeScriptLanguageInput(value: unknown): TypeScriptLanguageInput | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  if (typeof input.path !== 'string' || input.path.length === 0 || input.path.length > 4_096) return null
  if (typeof input.content !== 'string') return null
  if (!Number.isSafeInteger(input.line) || !Number.isSafeInteger(input.column)) return null
  return { path: input.path, content: input.content, line: input.line as number, column: input.column as number }
}

function withTypeScriptInput(
  value: unknown,
  run: (input: TypeScriptLanguageInput) => unknown,
  invalid: unknown
): unknown {
  const input = typeScriptLanguageInput(value)
  return input ? run(input) : invalid
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
