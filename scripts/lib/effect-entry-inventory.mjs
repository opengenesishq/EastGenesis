import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const TOOL_ENTRY_FILE = 'src/main/openaiTools.ts'
const EFFECT_ENTRY_POLICY_FILE = 'src/main/task/effect-entry-inventory.ts'
const EFFECT_TYPES_FILE = 'src/shared/effect-types.ts'
const EFFECT_RECONCILER_DISPATCH_FILES = [
  'src/main/task/effect-reconciler.ts',
  'src/main/task/effect-reconciler-local-targets.ts'
]

const ACTION_MAP_SPECS = [
  {
    channel: 'digitalWorker:invoke',
    file: 'src/main/ipc/digital-worker-handlers.ts',
    variable: 'DIGITAL_WORKER_ACTION_HANDLERS',
    additionalReadOnly: ['exportDigitalWorkerHistory'],
    mutationSet: {
      file: 'src/main/ipc/digital-worker-project-mutation.ts',
      variable: 'PROJECT_OWNED_ACTIONS'
    }
  },
  {
    channel: 'projectWorkspace:invoke',
    file: 'src/main/ipc/project-workspace-handlers.ts',
    variable: 'PROJECT_WORKSPACE_HANDLERS',
    mutationSet: {
      file: 'src/main/ipc/project-workspace-handlers.ts',
      variable: 'PROJECT_WORKSPACE_MUTATIONS'
    },
    additionalMutations: ['export']
  },
  {
    channel: 'supervisor:invoke',
    file: 'src/main/ipc/supervisor-handlers.ts',
    variable: 'HANDLERS',
    readOnlyActions: ['list', 'get', 'events']
  }
]

const APP_FEATURE_ACTION_SPECS = [
  { feature: 'office-revision', staticActions: ['inspect', 'plan'], readOnlyActions: ['inspect', 'plan'] },
  {
    feature: 'session-query',
    file: 'src/main/ipc/session-query-handlers.ts',
    typeAlias: 'SessionQueryAction',
    readOnlyActions: ['discover']
  },
  {
    feature: 'task-plan',
    file: 'src/main/ipc/task-plan-handlers.ts',
    typeAlias: 'TaskPlanAction',
    readOnlyActions: ['get']
  },
  {
    feature: 'studio-result',
    file: 'src/main/ipc/studio-result-handlers.ts',
    typeAlias: 'StudioResultAction',
    readOnlyActions: ['get', 'audit', 'export']
  },
  {
    feature: 'provider-profile',
    file: 'src/main/ipc/provider-profile-handlers.ts',
    typeAlias: 'ProviderProfileAction',
    readOnlyActions: [
      'preview', 'backups',
      'native-codex-preview', 'native-backups',
      'backup-preview'
    ]
  },
  {
    feature: 'provider-profile-sync',
    file: 'src/main/ipc/provider-profile-sync-handlers.ts',
    typeAlias: 'ProviderProfileSyncAction',
    readOnlyActions: [
      'status', 'preview',
      'webdav-config', 'webdav-preview', 'webdav-history-list', 'webdav-history-preview',
      's3-config', 's3-preview', 's3-history-list', 's3-history-preview'
    ]
  },
  {
    feature: 'media',
    staticActions: [
      'get', 'provider:list', 'provider:upsert', 'provider:delete', 'ffmpeg:get',
      'production:create', 'production:revise', 'shot:create', 'shot:update',
      'dialogue:upsert', 'dialogue:delete', 'timeline:update', 'budget:update',
      'storage:update', 'bible:upsert', 'bible:delete', 'continuity-lock:upsert',
      'continuity-lock:delete', 'continuity:check', 'asset:import', 'asset:bind',
      'asset:adopt', 'asset:retention', 'asset:purge', 'asset:egress',
      'asset:voice-clone', 'compose', 'job:submit', 'job:advance', 'job:reconcile', 'job:cancel'
    ],
    readOnlyActions: ['get', 'provider:list', 'ffmpeg:get', 'continuity:check', 'job:reconcile']
  }
]

const EXTERNAL_ENTRY_SPECS = [
  {
    id: 'external:provider:openai-model-request',
    file: 'src/main/openaiEngine.ts',
    anchor: 'OpenAI',
    expectedAccess: 'mutation'
  },
  {
    id: 'external:provider:anthropic-model-request',
    file: 'src/main/anthropicEngine.ts',
    anchor: 'Anthropic',
    expectedAccess: 'mutation'
  },
  {
    id: 'external:connector:mcp-tool-call',
    file: 'src/main/mcp/mcp-effect.ts',
    anchor: 'buildMcpEffectTarget',
    expectedAccess: 'mutation'
  },
  {
    id: 'external:connector:notification-send',
    file: 'src/main/notification/notification-effect.ts',
    anchor: 'buildWebhookMessageEffectTarget',
    expectedAccess: 'mutation'
  },
  {
    id: 'external:connector:pull-request-create',
    file: 'src/main/git/pull-request-effect.ts',
    anchor: 'buildPullRequestEffectTarget',
    expectedAccess: 'mutation'
  },
  {
    id: 'external:connector:issue-create',
    file: 'src/main/git/pull-request-effect.ts',
    anchor: 'buildIssueEffectTarget',
    expectedAccess: 'mutation'
  }
]

const MUTATION_NAME = /(?:^|[:/#_-])(?:activate|add|apply|approve|archive|cancel|capture|close|commit|complete|coordinate|copy|create|delete|discard|dispatch|export|fail|heartbeat|import|install|interrupt|mark|merge|navigate|open|pause|prepare|purge|reassign|recover|reject|release|remove|rename|reorder|restore|resume|retry|review|revoke|rollback|run|save|send|set|stage|start|transition|type|uninstall|unstage|update|write)(?:$|[:/#_-])/i
const CAMEL_MUTATION_NAME = /(?:activate|add|apply|approve|archive|cancel|capture|close|commit|complete|coordinate|copy|create|delete|discard|dispatch|export|fail|heartbeat|import|install|interrupt|mark|merge|navigate|open|pause|prepare|purge|reassign|recover|reject|release|remove|rename|reorder|restore|resume|retry|review|revoke|rollback|run|save|send|set|stage|start|transition|type|uninstall|unstage|update|write)[A-Z]/
const READ_ONLY_MUTATION_NAME_EXCEPTIONS = new Set([
  'startSuggestions:get',
  'workflowLedger:export',
  'worktrees:applyCheck',
  'worktrees:mergeInspect',
  'worktrees:mergeReceipts'
])

export function discoverEffectEntries(repoRoot) {
  const resolver = createResolver(repoRoot)
  const tools = discoverTools(resolver)
  const ipc = discoverIpc(resolver)
  const actions = discoverActions(resolver)
  const external = discoverExternal(resolver)
  const entries = [...tools, ...ipc, ...actions, ...external].sort(compareEntryId)
  assertUnique(entries.map((entry) => entry.id), 'discovered entry')
  return {
    entries,
    effectTargetKinds: discoverEffectTargetKinds(resolver),
    reconciledTargetKinds: discoverReconciledTargetKinds(resolver)
  }
}

export function validateEffectEntryRegistry(registry, discovery) {
  const failures = []
  const registryById = new Map()
  for (const entry of registry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      failures.push('registry entry must be an object')
      continue
    }
    if (typeof entry.id !== 'string' || !entry.id) {
      failures.push('registry entry id must be a non-empty string')
      continue
    }
    if (registryById.has(entry.id)) failures.push(`duplicate registry entry: ${entry.id}`)
    registryById.set(entry.id, entry)
  }

  const discoveredById = new Map(discovery.entries.map((entry) => [entry.id, entry]))
  for (const discovered of discovery.entries) {
    const registered = registryById.get(discovered.id)
    if (!registered) {
      failures.push(`unregistered effect entry: ${discovered.id} (${discovered.locator})`)
      continue
    }
    validateEntry(registered, discovered, discovery, failures)
  }
  for (const registered of registry) {
    if (registered?.id && !discoveredById.has(registered.id)) {
      failures.push(`stale registry entry: ${registered.id}`)
    }
  }
  return failures
}

function validateEntry(entry, discovered, discovery, failures) {
  validateEntryShape(entry, failures)
  validateEntryAccess(entry, discovered, failures)
  validateQueryableEntry(entry, discovery, failures)
  validateReplayPolicy(entry, failures)
}

function validateEntryShape(entry, failures) {
  if (!['read_only', 'mutation'].includes(entry.access)) {
    failures.push(`${entry.id}: access must be read_only or mutation`)
  }
  if (!['none', 'queryable', 'opaque', 'durable_local', 'delegated', 'direct_user'].includes(entry.effectPolicy)) {
    failures.push(`${entry.id}: invalid effectPolicy`)
  }
  if (typeof entry.owner !== 'string' || !entry.owner.trim()) failures.push(`${entry.id}: owner is required`)
  if (typeof entry.rationale !== 'string' || entry.rationale.trim().length < 12) {
    failures.push(`${entry.id}: rationale must be explicit`)
  }
}

function validateEntryAccess(entry, discovered, failures) {
  if (discovered.expectedAccess && entry.access !== discovered.expectedAccess) {
    failures.push(`${entry.id}: access ${entry.access} conflicts with discovered ${discovered.expectedAccess}`)
  }
  if (entry.access === 'read_only' && entry.effectPolicy !== 'none') {
    failures.push(`${entry.id}: read_only entry must use effectPolicy=none`)
  }
  if (entry.effectPolicy === 'none' && entry.access === 'mutation' &&
    !['ephemeral_local', 'blocked_before_execution'].includes(entry.boundary)) {
    failures.push(`${entry.id}: mutation without Effect requires an explicit local or fail-closed boundary`)
  }
}

function validateQueryableEntry(entry, discovery, failures) {
  if (entry.effectPolicy !== 'queryable') return
  if (entry.access !== 'mutation') failures.push(`${entry.id}: queryable entry must be a mutation`)
  if (!Array.isArray(entry.effectTargets) || entry.effectTargets.length === 0) {
    failures.push(`${entry.id}: queryable entry requires effectTargets`)
    return
  }
  for (const target of entry.effectTargets) validateQueryableTarget(entry, target, discovery, failures)
}

function validateQueryableTarget(entry, target, discovery, failures) {
  if (!discovery.effectTargetKinds.has(target)) {
    failures.push(`${entry.id}: EffectTarget ${target} is not declared`)
  } else if (!discovery.reconciledTargetKinds.has(target)) {
    failures.push(`${entry.id}: EffectTarget ${target} has no Reconciler`)
  }
}

function validateReplayPolicy(entry, failures) {
  if (entry.effectPolicy === 'queryable' && entry.replayPolicy !== 'reconcile_before_retry') {
    failures.push(`${entry.id}: queryable entry must reconcile before retry`)
  }
  if (entry.effectPolicy === 'opaque' && entry.replayPolicy !== 'manual_only') {
    failures.push(`${entry.id}: opaque entry cannot authorize automatic replay`)
  }
  if (entry.effectPolicy === 'durable_local' && entry.replayPolicy !== 'idempotent_resume') {
    failures.push(`${entry.id}: durable_local entry requires idempotent_resume`)
  }
  if (entry.effectPolicy === 'delegated' &&
      (entry.replayPolicy !== 'downstream_barrier' || typeof entry.evidence !== 'string' || !entry.evidence.trim())) {
    failures.push(`${entry.id}: delegated entry requires downstream boundary evidence`)
  }
  if (entry.effectPolicy === 'direct_user' && entry.replayPolicy !== 'never') {
    failures.push(`${entry.id}: direct_user entry must never be replayed`)
  }
  if (entry.effectPolicy === 'none' && entry.replayPolicy !== 'not_applicable') {
    failures.push(`${entry.id}: effectPolicy=none requires replayPolicy=not_applicable`)
  }
}

function discoverTools(resolver) {
  const context = resolver.context(TOOL_ENTRY_FILE)
  const declaration = resolver.variable(context, 'OPENAI_CODING_TOOLS')
  const names = resolver.toolArray(declaration.initializer, context)
  const accessByName = resolver.policyGroupAccess(
    EFFECT_ENTRY_POLICY_FILE,
    'AGENT_TOOL_EFFECT_ENTRY_POLICIES'
  )
  return [...names].sort().map((name) => ({
    id: `tool:${name}`,
    surface: 'tool',
    locator: TOOL_ENTRY_FILE,
    // Tools absent from the runtime policy inventory remain fail-closed mutations.
    expectedAccess: accessByName.get(name) ?? 'mutation'
  }))
}

function discoverIpc(resolver) {
  const entries = []
  for (const relativePath of sourceFiles(path.join(resolver.repoRoot, 'src/main'), resolver.repoRoot)) {
    const context = resolver.context(relativePath)
    visit(context.sourceFile, (node) => {
      if (!isIpcHandle(node)) return
      const channel = resolver.string(node.arguments[0], context)
      if (!channel) throw new Error(`${relativePath}:${lineOf(context.sourceFile, node)} ipcMain.handle channel must be static`)
      entries.push({
        id: `ipc:${channel}`,
        surface: 'ipc',
        locator: `${relativePath}:${lineOf(context.sourceFile, node)}`,
        expectedAccess: READ_ONLY_MUTATION_NAME_EXCEPTIONS.has(channel)
          ? 'read_only'
          : looksMutating(channel) ? 'mutation' : undefined
      })
    })
  }
  return entries
}

function discoverActions(resolver) {
  const entries = []
  for (const spec of ACTION_MAP_SPECS) {
    const actions = resolver.objectKeys(spec.file, spec.variable)
    const mutations = spec.mutationSet
      ? new Set(resolver.stringSet(spec.mutationSet.file, spec.mutationSet.variable))
      : new Set(actions.filter((action) => !spec.readOnlyActions.includes(action)))
    for (const action of spec.additionalMutations ?? []) mutations.add(action)
    for (const action of actions) {
      const explicitlyReadOnly = spec.readOnlyActions?.includes(action) || spec.additionalReadOnly?.includes(action)
      entries.push({
        id: `ipc-action:${spec.channel}#${action}`,
        surface: 'ipc_action',
        locator: `${spec.file}:${spec.variable}`,
        expectedAccess: explicitlyReadOnly
          ? 'read_only'
          : mutations.has(action) || looksMutating(action) ? 'mutation' : 'read_only'
      })
    }
  }
  for (const spec of APP_FEATURE_ACTION_SPECS) {
    const actions = spec.staticActions ?? resolver.typeUnionStrings(spec.file, spec.typeAlias)
    for (const action of actions) {
      entries.push({
        id: `ipc-action:appFeatures:invoke#${spec.feature}/${action}`,
        surface: 'ipc_action',
        locator: `${spec.file}:${spec.typeAlias}`,
        expectedAccess: spec.readOnlyActions.includes(action) ? 'read_only' : 'mutation'
      })
    }
  }
  return entries
}

function discoverExternal(resolver) {
  return EXTERNAL_ENTRY_SPECS.map((spec) => {
    const source = resolver.context(spec.file).source
    if (!source.includes(spec.anchor)) throw new Error(`${spec.id}: source anchor ${spec.anchor} is missing`)
    return {
      id: spec.id,
      surface: 'external',
      locator: `${spec.file}#${spec.anchor}`,
      expectedAccess: spec.expectedAccess
    }
  })
}

function discoverEffectTargetKinds(resolver) {
  const context = resolver.context(EFFECT_TYPES_FILE)
  const alias = findTypeAlias(context.sourceFile, 'EffectTarget')
  const kinds = new Set()
  collectEffectTargetKinds(alias.type, context, resolver, kinds, new Set())
  return kinds
}

function collectEffectTargetKinds(type, context, resolver, kinds, seen) {
  if (ts.isUnionTypeNode(type)) {
    for (const member of type.types) collectEffectTargetKinds(member, context, resolver, kinds, seen)
    return
  }
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    const binding = resolveEffectTargetType(type.typeName.text, context, resolver)
    const key = `${binding.context.relativePath}:${binding.declaration.name.text}`
    if (seen.has(key)) throw new Error(`cyclic EffectTarget type: ${key}`)
    return collectEffectTargetKinds(binding.declaration.type ?? binding.declaration, binding.context,
      resolver, kinds, new Set([...seen, key]))
  }
  if (!ts.isTypeLiteralNode(type) && !ts.isInterfaceDeclaration(type)) throw new Error('EffectTarget must have a static declared shape')
  if (type.heritageClauses?.length) throw new Error('EffectTarget interface inheritance must be explicitly resolved')
  const kind = type.members.find((member) => ts.isPropertySignature(member) && propertyName(member.name) === 'kind')
  if (!kind?.type) throw new Error('EffectTarget member lacks a declared kind')
  collectLiteralTypeStrings(kind.type, kinds)
}

function resolveEffectTargetType(name, context, resolver) {
  const imported = context.imports.get(name)
  if (imported) {
    if (!imported.specifier.startsWith('.')) throw new Error('EffectTarget type must be a local source declaration')
    context = resolver.context(resolveSourceModule(context.relativePath, imported.specifier, resolver.repoRoot))
    name = imported.imported
  }
  const declaration = context.sourceFile.statements.find((item) =>
    (ts.isTypeAliasDeclaration(item) || ts.isInterfaceDeclaration(item)) && item.name.text === name)
  if (!declaration) throw new Error(`${context.relativePath}: EffectTarget type ${name} is missing`)
  return { context, declaration }
}

function discoverReconciledTargetKinds(resolver) {
  const kinds = new Set()
  for (const relativePath of EFFECT_RECONCILER_DISPATCH_FILES) {
    const context = resolver.context(relativePath)
    visit(context.sourceFile, (node) => {
      if (ts.isBinaryExpression(node) && ['===', '=='].includes(node.operatorToken.getText(context.sourceFile))) {
        collectKindComparison(node.left, node.right, kinds)
        collectKindComparison(node.right, node.left, kinds)
      }
      if (ts.isCaseClause(node) && node.expression) {
        const value = resolver.string(node.expression, context)
        if (value) kinds.add(value)
      }
    })
  }
  return kinds
}

function createResolver(repoRoot) {
  const cache = new Map()
  const resolver = {
    repoRoot,
    context(relativePath) {
      const normalized = relativePath.replaceAll(path.sep, '/')
      if (cache.has(normalized)) return cache.get(normalized)
      const absolutePath = path.join(repoRoot, normalized)
      const source = readFileSync(absolutePath, 'utf8')
      const sourceFile = ts.createSourceFile(normalized, source, ts.ScriptTarget.Latest, true, scriptKind(normalized))
      const context = { relativePath: normalized, absolutePath, source, sourceFile, declarations: new Map(), imports: new Map() }
      indexContext(context)
      cache.set(normalized, context)
      return context
    },
    variable(context, name) {
      const declaration = context.declarations.get(name)
      if (!declaration || !ts.isVariableDeclaration(declaration)) {
        throw new Error(`${context.relativePath}: variable ${name} is missing`)
      }
      return declaration
    },
    string(expression, context, seen = new Set()) {
      const value = unwrap(expression)
      if (!value) return undefined
      if (ts.isStringLiteralLike(value)) return value.text
      if (!ts.isIdentifier(value)) return undefined
      const binding = resolveBinding(value.text, context, resolver)
      if (!binding) return undefined
      const key = `${binding.context.relativePath}:${value.text}`
      if (seen.has(key)) throw new Error(`cyclic static binding: ${key}`)
      seen.add(key)
      return resolver.string(binding.expression, binding.context, seen)
    },
    stringArray(expression, context, seen = new Set()) {
      const value = unwrap(expression)
      if (!value) return []
      if (ts.isNewExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'Set') {
        return resolver.stringArray(value.arguments?.[0], context, seen)
      }
      if (ts.isIdentifier(value)) {
        const binding = resolveBinding(value.text, context, resolver)
        if (!binding) throw new Error(`${context.relativePath}: unresolved string array ${value.text}`)
        const key = `${binding.context.relativePath}:${value.text}`
        if (seen.has(key)) throw new Error(`cyclic static array binding: ${key}`)
        return resolver.stringArray(binding.expression, binding.context, new Set([...seen, key]))
      }
      if (!ts.isArrayLiteralExpression(value)) throw new Error(`${context.relativePath}: expected a static string array`)
      const result = []
      for (const element of value.elements) {
        if (ts.isSpreadElement(element)) result.push(...resolver.stringArray(element.expression, context, seen))
        else {
          const literal = resolver.string(element, context)
          if (!literal) throw new Error(`${context.relativePath}: string array contains a dynamic value`)
          result.push(literal)
        }
      }
      return result
    },
    stringSet(relativePath, name) {
      const context = resolver.context(relativePath)
      return resolver.stringArray(resolver.variable(context, name).initializer, context)
    },
    policyGroupAccess(relativePath, name) {
      const context = resolver.context(relativePath)
      const initializer = unwrap(resolver.variable(context, name).initializer)
      if (!isNamedCall(initializer, 'mergePolicyGroups')) {
        throw new Error(`${relativePath}:${name} must use mergePolicyGroups(...)`)
      }
      const result = new Map()
      for (const groupExpression of initializer.arguments) {
        const group = unwrap(groupExpression)
        const { ids, access } = staticPolicyGroup(group, resolver, context, relativePath, name)
        for (const id of ids) {
          if (result.has(id)) throw new Error(`${relativePath}:${name} declares ${id} more than once`)
          result.set(id, access)
        }
      }
      return result
    },
    objectStringProperty(expression, context, name) {
      let value = unwrap(expression)
      let valueContext = context
      if (ts.isIdentifier(value)) {
        const binding = resolveBinding(value.text, context, resolver)
        if (!binding) throw new Error(`${context.relativePath}: unresolved object ${value.text}`)
        value = unwrap(binding.expression)
        valueContext = binding.context
      }
      if (!ts.isObjectLiteralExpression(value)) {
        throw new Error(`${valueContext.relativePath}: expected a static object`)
      }
      const property = objectProperty(value, name)
      const literal = property && resolver.string(property.initializer, valueContext)
      if (!literal) throw new Error(`${valueContext.relativePath}: object property ${name} must be static`)
      return literal
    },
    toolArray(expression, context, seen = new Set()) {
      const value = unwrap(expression)
      if (ts.isIdentifier(value)) {
        const binding = resolveBinding(value.text, context, resolver)
        if (!binding) throw new Error(`${context.relativePath}: unresolved tool array ${value.text}`)
        const key = `${binding.context.relativePath}:${value.text}`
        if (seen.has(key)) throw new Error(`cyclic tool array binding: ${key}`)
        return resolver.toolArray(binding.expression, binding.context, new Set([...seen, key]))
      }
      if (!ts.isArrayLiteralExpression(value)) throw new Error(`${context.relativePath}: tool registry must be a static array`)
      const names = new Set()
      for (const element of value.elements) {
        if (ts.isSpreadElement(element)) {
          for (const name of resolver.toolArray(element.expression, context, seen)) names.add(name)
          continue
        }
        const object = unwrap(element)
        if (!ts.isObjectLiteralExpression(object)) throw new Error(`${context.relativePath}: dynamic tool entry is forbidden`)
        const functionProperty = objectProperty(object, 'function')
        const functionObject = functionProperty && unwrap(functionProperty.initializer)
        if (!functionObject || !ts.isObjectLiteralExpression(functionObject)) {
          throw new Error(`${context.relativePath}: tool entry has no static function object`)
        }
        const nameProperty = objectProperty(functionObject, 'name')
        const name = nameProperty && resolver.string(nameProperty.initializer, context)
        if (!name) throw new Error(`${context.relativePath}: tool name must be static`)
        names.add(name)
      }
      return names
    },
    objectKeys(relativePath, name) {
      const context = resolver.context(relativePath)
      const initializer = unwrap(resolver.variable(context, name).initializer)
      return staticObjectKeys(initializer, context, resolver, new Set([`${relativePath}:${name}`]))
    },
    typeUnionStrings(relativePath, name) {
      const context = resolver.context(relativePath)
      const alias = findTypeAlias(context.sourceFile, name)
      const result = new Set()
      collectTypeAliasLiteralStrings(alias.type, context.sourceFile, result, new Set([name]))
      if (result.size === 0) throw new Error(`${relativePath}:${name} has no static string members`)
      return [...result]
    }
  }
  return resolver
}

function staticObjectKeys(expression, context, resolver, seen) {
  const value = unwrap(expression)
  if (ts.isIdentifier(value)) {
    const binding = resolveBinding(value.text, context, resolver)
    if (!binding) throw new Error(`${context.relativePath}: unresolved object spread ${value.text}`)
    const key = `${binding.context.relativePath}:${value.text}`
    if (seen.has(key)) throw new Error(`cyclic static object binding: ${key}`)
    return staticObjectKeys(binding.expression, binding.context, resolver, new Set([...seen, key]))
  }
  if (!ts.isObjectLiteralExpression(value)) throw new Error(`${context.relativePath}: expected a static object`)
  const keys = []
  for (const property of value.properties) {
    if (ts.isSpreadAssignment(property)) {
      keys.push(...staticObjectKeys(property.expression, context, resolver, seen))
      continue
    }
    const key = propertyName(property.name)
    if (!key) throw new Error(`${context.relativePath}: static object contains a dynamic key`)
    keys.push(key)
  }
  return keys
}

function indexContext(context) {
  for (const statement of context.sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) context.declarations.set(declaration.name.text, declaration)
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) context.declarations.set(statement.name.text, statement)
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const clause = statement.importClause
    if (!clause) continue
    if (clause.name) context.imports.set(clause.name.text, { imported: 'default', specifier: statement.moduleSpecifier.text })
    const bindings = clause.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        context.imports.set(element.name.text, {
          imported: element.propertyName?.text ?? element.name.text,
          specifier: statement.moduleSpecifier.text
        })
      }
    }
  }
}

function resolveBinding(name, context, resolver) {
  const local = context.declarations.get(name)
  if (local && ts.isVariableDeclaration(local) && local.initializer) {
    return { context, expression: local.initializer }
  }
  const imported = context.imports.get(name)
  if (!imported || !imported.specifier.startsWith('.')) return undefined
  const relativePath = resolveSourceModule(context.relativePath, imported.specifier, resolver.repoRoot)
  const importedContext = resolver.context(relativePath)
  const declaration = importedContext.declarations.get(imported.imported)
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return undefined
  return { context: importedContext, expression: declaration.initializer }
}

function resolveSourceModule(fromFile, specifier, repoRoot) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier))
  const extensionless = base.replace(/\.(?:js|mjs|cjs)$/, '')
  for (const candidate of [`${extensionless}.ts`, `${extensionless}.tsx`, `${extensionless}/index.ts`]) {
    if (existsSync(path.join(repoRoot, candidate))) return candidate
  }
  throw new Error(`${fromFile}: cannot resolve ${specifier}`)
}

function sourceFiles(directory, repoRoot) {
  const result = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...sourceFiles(absolutePath, repoRoot))
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      result.push(path.relative(repoRoot, absolutePath).replaceAll(path.sep, '/'))
    }
  }
  return result.sort()
}

function findTypeAlias(sourceFile, name) {
  const alias = sourceFile.statements.find((statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === name)
  if (!alias) throw new Error(`${sourceFile.fileName}: type alias ${name} is missing`)
  return alias
}

function collectLiteralTypeStrings(typeNode, result) {
  if (ts.isUnionTypeNode(typeNode)) {
    for (const member of typeNode.types) collectLiteralTypeStrings(member, result)
  } else if (ts.isLiteralTypeNode(typeNode) && ts.isStringLiteral(typeNode.literal)) {
    result.add(typeNode.literal.text)
  }
}

function collectTypeAliasLiteralStrings(typeNode, sourceFile, result, seen) {
  if (ts.isUnionTypeNode(typeNode)) {
    for (const member of typeNode.types) collectTypeAliasLiteralStrings(member, sourceFile, result, seen)
    return
  }
  if (ts.isLiteralTypeNode(typeNode) && ts.isStringLiteral(typeNode.literal)) {
    result.add(typeNode.literal.text)
    return
  }
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const name = typeNode.typeName.text
    if (seen.has(name)) throw new Error(`${sourceFile.fileName}: cyclic type alias ${name}`)
    const alias = sourceFile.statements.find((statement) =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === name)
    if (!alias) throw new Error(`${sourceFile.fileName}: type alias ${name} is not local and static`)
    collectTypeAliasLiteralStrings(alias.type, sourceFile, result, new Set([...seen, name]))
    return
  }
  throw new Error(`${sourceFile.fileName}: type union contains a non-static member`)
}

function collectKindComparison(propertySide, literalSide, result) {
  if (!ts.isPropertyAccessExpression(propertySide) || propertySide.name.text !== 'kind') return
  if (ts.isStringLiteralLike(literalSide)) result.add(literalSide.text)
}

function isIpcHandle(node) {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'ipcMain' &&
    node.expression.name.text === 'handle' && node.arguments.length > 0
}

function isNamedCall(node, name) {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name
}

function objectProperty(object, name) {
  return object.properties.find((property) => ts.isPropertyAssignment(property) && propertyName(property.name) === name)
}

function propertyName(name) {
  if (!name) return undefined
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text
  return undefined
}

function unwrap(expression) {
  let value = expression
  while (value && (ts.isAsExpression(value) || ts.isTypeAssertionExpression(value) ||
    ts.isParenthesizedExpression(value) || ts.isSatisfiesExpression(value) || ts.isNonNullExpression(value))) {
    value = value.expression
  }
  return value
}

function looksMutating(value) {
  return MUTATION_NAME.test(value) || CAMEL_MUTATION_NAME.test(value)
}

function visit(node, callback) {
  callback(node)
  ts.forEachChild(node, (child) => visit(child, callback))
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function scriptKind(relativePath) {
  return relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

function assertUnique(values, label) {
  const seen = new Set()
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`)
    seen.add(value)
  }
}

function compareEntryId(left, right) {
  return left.id.localeCompare(right.id)
}

function staticPolicyGroup(group, resolver, context, relativePath, name) {
  if (isNamedCall(group, 'delegatedPolicyGroup') && group.arguments.length === 1) {
    const entries = unwrap(group.arguments[0])
    if (!ts.isObjectLiteralExpression(entries)) throw new Error(`${relativePath}:${name} delegated entries must be a static evidence map`)
    const ids = entries.properties.map((property) => {
      if (!ts.isPropertyAssignment(property)) throw new Error(`${relativePath}:${name} delegated entry must be a property`)
      const id = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : undefined
      const evidence = resolver.string(property.initializer, context)
      if (!id || !evidence?.trim()) throw new Error(`${relativePath}:${name} delegated entry requires static id and evidence`)
      return id
    })
    return { ids, access: 'mutation' }
  }
  if (!isNamedCall(group, 'policyGroup') || group.arguments.length < 2) throw new Error(`${relativePath}:${name} must contain only policyGroup(...) or static delegatedPolicyGroup(...) entries`)
  return { ids: resolver.stringArray(group.arguments[0], context),
    access: resolver.objectStringProperty(group.arguments[1], context, 'impact') === 'read_only' ? 'read_only' : 'mutation' }
}
