import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const FILESYSTEM_MODULES = new Set(['fs', 'fs/promises', 'node:fs', 'node:fs/promises'])
const DURABLE_FILE_OPERATIONS = new Set(['writeDurableFile', 'writeDurableFileSync'])
const FILESYSTEM_OPERATIONS = new Set([
  'appendFile', 'appendFileSync',
  'chmod', 'chmodSync',
  'chown', 'chownSync',
  'copyFile', 'copyFileSync',
  'cp', 'cpSync',
  'createWriteStream',
  'fdatasync', 'fdatasyncSync',
  'fsync', 'fsyncSync',
  'link', 'linkSync',
  'mkdir', 'mkdirSync',
  'rename', 'renameSync',
  'rm', 'rmSync',
  'rmdir', 'rmdirSync',
  'symlink', 'symlinkSync',
  'truncate', 'truncateSync',
  'unlink', 'unlinkSync',
  'utimes', 'utimesSync',
  'write', 'writeFile', 'writeFileSync', 'writeSync', 'writev', 'writevSync',
  'writeDurableFile', 'writeDurableFileSync'
])
const FILE_HANDLE_OPERATIONS = new Set([
  'appendFile', 'chmod', 'chown', 'createWriteStream', 'datasync', 'sync',
  'truncate', 'utimes', 'write', 'writeFile', 'writev'
])
const DURABILITY_OPERATIONS = new Set([
  'datasync', 'fdatasync', 'fdatasyncSync', 'fsync', 'fsyncSync', 'sync'
])
const MATERIAL_WRITE_OPERATIONS = new Set([
  'appendFile', 'appendFileSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync',
  'createWriteStream', 'link', 'linkSync', 'rename', 'renameSync', 'symlink',
  'symlinkSync', 'truncate', 'truncateSync', 'write', 'writeFile', 'writeFileSync',
  'writeSync', 'writev', 'writevSync', 'writeDurableFile', 'writeDurableFileSync'
])

const DATA_CLASSES = new Set([
  'domain_state',
  'journal',
  'audit_log',
  'derived_index',
  'migration_backup',
  'user_artifact',
  'workspace_effect',
  'ephemeral_runtime'
])
const SCHEMA_REQUIRED_CLASSES = new Set([
  'domain_state', 'journal', 'audit_log', 'derived_index'
])
const EXEMPT_CLASSES = new Set([
  'migration_backup', 'user_artifact', 'workspace_effect', 'ephemeral_runtime'
])
const STRATEGIES = new Set([
  'atomic_fsync_rename',
  'atomic_rename',
  'atomic_link',
  'sqlite_transaction_export',
  'append_log',
  'delegated_atomic',
  'effect_guarded_workspace',
  'direct_write',
  'ephemeral'
])
const RECOVERY_STATES = new Set(['verified', 'implemented_unverified', 'gap', 'exempt'])

export function discoverDurableWriteModules(repoRoot) {
  const sourceRoot = path.join(repoRoot, 'src/main')
  const modules = []
  for (const absolutePath of sourceFiles(sourceRoot)) {
    const relativePath = normalizePath(path.relative(repoRoot, absolutePath))
    const sourceText = readFileSync(absolutePath, 'utf8')
    const sourceFile = ts.createSourceFile(
      relativePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    )
    const bindings = collectFilesystemBindings(sourceFile)
    const sinks = collectFilesystemSinks(sourceFile, bindings)
    if (sinks.some((sink) => !DURABILITY_OPERATIONS.has(sink.operation))) {
      modules.push({
        id: `writer:${relativePath}`,
        file: relativePath,
        sinks
      })
    }
  }
  return modules.sort((left, right) => left.file.localeCompare(right.file))
}

export function validateDurableWriteRegistry(registry, discovery) {
  const failures = []
  const registeredByFile = new Map()
  for (const entry of registry) {
    validateRegistryEntryShape(entry, failures)
    if (!entry || typeof entry.file !== 'string' || !entry.file) continue
    if (registeredByFile.has(entry.file)) failures.push(`duplicate writer registry entry: ${entry.file}`)
    registeredByFile.set(entry.file, entry)
  }

  const discoveredByFile = new Map(discovery.map((entry) => [entry.file, entry]))
  for (const discovered of discovery) {
    const registered = registeredByFile.get(discovered.file)
    if (!registered) {
      failures.push(`unregistered filesystem writer: ${discovered.file} (${formatSinks(discovered.sinks)})`)
      continue
    }
    validateSourceBackedStrategy(registered, discovered, failures)
  }
  for (const entry of registry) {
    if (entry?.file && !discoveredByFile.has(entry.file)) {
      failures.push(`stale writer registry entry: ${entry.file}`)
    }
  }
  return failures
}

function validateRegistryEntryShape(entry, failures) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    failures.push('writer registry entry must be an object')
    return
  }
  validateRegistryIdentity(entry, failures)
  validateSchemaDeclaration(entry, failures)
  validateGapDeclaration(entry, failures)
  validateExemptionDeclaration(entry, failures)
  validateStrategyDeclaration(entry, failures)
}

function validateRegistryIdentity(entry, failures) {
  if (typeof entry.file !== 'string' || !entry.file.startsWith('src/main/') || !entry.file.endsWith('.ts')) {
    failures.push(`${entry.file ?? '<missing>'}: file must identify a src/main TypeScript module`)
  }
  if (!DATA_CLASSES.has(entry.dataClass)) failures.push(`${entry.file}: invalid dataClass`)
  if (!STRATEGIES.has(entry.strategy)) failures.push(`${entry.file}: invalid strategy`)
  if (!RECOVERY_STATES.has(entry.recovery)) failures.push(`${entry.file}: invalid recovery state`)
  if (typeof entry.owner !== 'string' || entry.owner.trim().length < 5) {
    failures.push(`${entry.file}: owner is required`)
  }
  if (typeof entry.rationale !== 'string' || entry.rationale.trim().length < 16) {
    failures.push(`${entry.file}: rationale must be explicit`)
  }
}

function validateSchemaDeclaration(entry, failures) {
  if (SCHEMA_REQUIRED_CLASSES.has(entry.dataClass)) {
    if (typeof entry.schema !== 'string' || entry.schema.trim().length < 3) {
      failures.push(`${entry.file}: ${entry.dataClass} requires a schema declaration`)
    }
    if (typeof entry.version !== 'string' || entry.version.trim().length < 1) {
      failures.push(`${entry.file}: ${entry.dataClass} requires a version declaration`)
    }
    if (typeof entry.version === 'string' && /(?:unversioned|unknown|mixed)/i.test(entry.version) &&
        entry.recovery !== 'gap') {
      failures.push(`${entry.file}: an unversioned or mixed schema must remain an explicit recovery gap`)
    }
  } else if (entry.schema !== 'not_applicable' || entry.version !== 'not_applicable') {
    failures.push(`${entry.file}: exempt data class must declare schema/version as not_applicable`)
  }
}

function validateGapDeclaration(entry, failures) {
  if (entry.recovery === 'gap') {
    if (typeof entry.gap !== 'string' || entry.gap.trim().length < 16) {
      failures.push(`${entry.file}: recovery gap requires an explicit gap reason`)
    }
  } else if (entry.gap !== undefined) {
    failures.push(`${entry.file}: gap reason is only valid for recovery=gap`)
  }
}

function validateExemptionDeclaration(entry, failures) {
  if (entry.recovery === 'exempt') {
    if (!EXEMPT_CLASSES.has(entry.dataClass)) {
      failures.push(`${entry.file}: ${entry.dataClass} cannot be exempt from durable-domain recovery`)
    }
    if (typeof entry.exemption !== 'string' || entry.exemption.trim().length < 16) {
      failures.push(`${entry.file}: recovery exemption requires an explicit reason`)
    }
  } else if (entry.exemption !== undefined) {
    failures.push(`${entry.file}: exemption is only valid for recovery=exempt`)
  }
}

function validateStrategyDeclaration(entry, failures) {
  if (entry.strategy === 'direct_write' && entry.recovery !== 'gap' && entry.recovery !== 'exempt') {
    failures.push(`${entry.file}: direct_write must remain an explicit gap or exemption`)
  }
  if (entry.strategy === 'ephemeral' && entry.dataClass !== 'ephemeral_runtime') {
    failures.push(`${entry.file}: ephemeral strategy requires ephemeral_runtime dataClass`)
  }
  if (entry.strategy === 'delegated_atomic' &&
      (typeof entry.delegate !== 'string' || entry.delegate.trim().length < 5)) {
    failures.push(`${entry.file}: delegated_atomic requires a concrete delegate`)
  }
}

function validateSourceBackedStrategy(entry, discovered, failures) {
  const operations = new Set(discovered.sinks.map((sink) => sink.operation))
  if (entry.strategy === 'atomic_fsync_rename') {
    requireOperation(entry, operations, isDurablePublication, 'durable publication', failures)
  }
  if (entry.strategy === 'atomic_rename') {
    requireOperation(entry, operations, isDurablePublication, 'rename or durable publication', failures)
  }
  if (entry.strategy === 'atomic_link') {
    requireOperation(entry, operations, (operation) => operation === 'link' || operation === 'linkSync', 'link', failures)
  }
  if (entry.strategy === 'append_log') {
    requireOperation(
      entry,
      operations,
      (operation) => operation === 'appendFile' || operation === 'appendFileSync' || operation === 'createWriteStream',
      'append operation',
      failures
    )
  }
  if (entry.strategy === 'direct_write') {
    requireOperation(entry, operations, (operation) => MATERIAL_WRITE_OPERATIONS.has(operation), 'material write', failures)
  }
  if (entry.recovery === 'verified') {
    if (!Array.isArray(entry.evidence) || entry.evidence.length === 0 ||
        entry.evidence.some((item) => typeof item !== 'string' || !item.trim())) {
      failures.push(`${entry.file}: verified recovery requires named evidence`)
    }
  }
}

function requireOperation(entry, operations, predicate, label, failures) {
  if (![...operations].some(predicate)) {
    failures.push(`${entry.file}: ${entry.strategy} lacks source-observed ${label}`)
  }
}

function collectFilesystemBindings(sourceFile) {
  const bindings = { direct: new Map(), durable: new Map(), namespaces: new Set(), importsOpen: false }

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (filesystemModule(statement.moduleSpecifier)) collectFilesystemImport(statement, bindings)
    if (durableFileModule(statement.moduleSpecifier)) collectDurableFileImport(statement, bindings)
  }
  visit(sourceFile, (node) => collectRequireBindings(node, bindings))
  return bindings
}

function collectFilesystemImport(statement, bindings) {
  const namedBindings = statement.importClause?.namedBindings
  if (statement.importClause?.name) bindings.namespaces.add(statement.importClause.name.text)
  if (namedBindings && ts.isNamespaceImport(namedBindings)) bindings.namespaces.add(namedBindings.name.text)
  if (!namedBindings || !ts.isNamedImports(namedBindings)) return
  for (const element of namedBindings.elements) {
    const imported = (element.propertyName ?? element.name).text
    if (FILESYSTEM_OPERATIONS.has(imported)) bindings.direct.set(element.name.text, imported)
    if (imported === 'open' || imported === 'openSync') bindings.importsOpen = true
  }
}

function collectDurableFileImport(statement, bindings) {
  const namedBindings = statement.importClause?.namedBindings
  if (!namedBindings || !ts.isNamedImports(namedBindings)) return
  for (const element of namedBindings.elements) {
    const imported = (element.propertyName ?? element.name).text
    if (DURABLE_FILE_OPERATIONS.has(imported)) bindings.durable.set(element.name.text, imported)
  }
}

function collectRequireBindings(node, bindings) {
  if (!ts.isVariableDeclaration(node) || !node.initializer || !isFilesystemRequire(node.initializer)) return
  if (ts.isIdentifier(node.name)) {
    bindings.namespaces.add(node.name.text)
    return
  }
  if (!ts.isObjectBindingPattern(node.name)) return
  for (const element of node.name.elements) {
    if (!ts.isIdentifier(element.name)) continue
    const imported = element.propertyName && ts.isIdentifier(element.propertyName)
      ? element.propertyName.text
      : element.name.text
    if (FILESYSTEM_OPERATIONS.has(imported)) bindings.direct.set(element.name.text, imported)
    if (imported === 'open' || imported === 'openSync') bindings.importsOpen = true
  }
}

function collectFilesystemSinks(sourceFile, bindings) {
  const sinks = []
  const seen = new Set()
  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return
    const operation = filesystemCallOperation(node.expression, bindings)
    if (!operation) return
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
    const key = `${operation}:${line}`
    if (seen.has(key)) return
    seen.add(key)
    sinks.push({ operation, line })
  })
  return sinks.sort((left, right) => left.line - right.line || left.operation.localeCompare(right.operation))
}

function filesystemCallOperation(expression, bindings) {
  if (ts.isIdentifier(expression)) return bindings.direct.get(expression.text) ?? bindings.durable.get(expression.text)
  if (!ts.isPropertyAccessExpression(expression)) return undefined
  const operation = expression.name.text
  if (FILESYSTEM_OPERATIONS.has(operation) && hasNamespaceRoot(expression.expression, bindings.namespaces)) {
    return operation
  }
  if (bindings.importsOpen && FILE_HANDLE_OPERATIONS.has(operation)) return operation
  return undefined
}

function hasNamespaceRoot(expression, namespaces) {
  let current = expression
  while (ts.isPropertyAccessExpression(current)) current = current.expression
  return ts.isIdentifier(current) && namespaces.has(current.text)
}

function filesystemModule(node) {
  return ts.isStringLiteralLike(node) && FILESYSTEM_MODULES.has(node.text)
}

function durableFileModule(node) {
  return ts.isStringLiteralLike(node) && /(?:^|\/)durable-file$/.test(node.text.replace(/^\.\//, ''))
}

function isFilesystemRequire(node) {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return false
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'require') return false
  return filesystemModule(node.arguments[0])
}

function isRename(operation) {
  return operation === 'rename' || operation === 'renameSync'
}

function isDurablePublication(operation) {
  return isRename(operation) || operation === 'writeDurableFile' || operation === 'writeDurableFileSync'
}

function formatSinks(sinks) {
  return sinks.map((sink) => `${sink.operation}@${sink.line}`).join(', ')
}

function sourceFiles(root) {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...sourceFiles(absolutePath))
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts') ||
        entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts') ||
        entry.name.endsWith('.d.ts')) continue
    files.push(absolutePath)
  }
  return files
}

function visit(node, callback) {
  callback(node)
  node.forEachChild((child) => visit(child, callback))
}

function normalizePath(value) {
  return value.split(path.sep).join('/')
}
