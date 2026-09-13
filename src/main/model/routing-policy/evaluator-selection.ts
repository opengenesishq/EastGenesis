import type { RoutingSelection, RoutingUserIntent, RoutingTargetRef } from '../../../shared/routing-policy-types'
import type { RoutingCatalogEntry, TargetExclusion } from './evaluator-types'
import { resolveCatalogTarget, targetKey } from './evaluator-catalog'
import { issue } from './evaluator-rules'

/** All five selections are interpreted exactly once, then intersected with intent. */
export function compileRoutingSelection(input: {
  catalog: RoutingCatalogEntry[]; selection: RoutingSelection; intent: RoutingUserIntent
}): { entries: RoutingCatalogEntry[]; requiredInitial?: RoutingTargetRef; excluded: TargetExclusion[] } {
  const selection = selectionEntries(input.catalog, input.selection)
  const scoped = new Set(selection.entries.map((entry) => targetKey(entry.target)))
  const intended = intentKeys(input.catalog, input.intent)
  const entries = input.catalog.filter((entry) => scoped.has(targetKey(entry.target)) && intended.has(targetKey(entry.target)))
  const excluded = input.catalog.filter((entry) => !entries.includes(entry)).map((entry) => ({ target: entry.target,
    diagnostics: [issue('HARD_CONSTRAINT_EXCLUDED', '$.selection', 'Excluded by the user intent ∩ winning rule selection.')] }))
  const requiredInitial = selection.requiredInitial ?? fixedIntentTarget(input.catalog, input.intent)
  return { entries, requiredInitial, excluded: [...selection.missing, ...excluded] }
}

function selectionEntries(catalog: RoutingCatalogEntry[], selection: RoutingSelection): {
  entries: RoutingCatalogEntry[]; requiredInitial?: RoutingTargetRef; missing: TargetExclusion[]
} {
  if (selection.kind === 'global_auto') return { entries: catalog, missing: [] }
  if (selection.kind === 'provider_auto') return { entries: catalog.filter((entry) => entry.provider.id === selection.providerId), missing: [] }
  if (selection.kind === 'candidate_set') return resolveNamedTargets(catalog, selection.targets)
  if (selection.kind === 'fixed') return { ...resolveNamedTargets(catalog, [selection.target]),
    requiredInitial: resolveCatalogTarget(catalog, selection.target)?.target ?? selection.target }
  return { ...resolveNamedTargets(catalog, [selection.primary, ...selection.alternatives]),
    requiredInitial: resolveCatalogTarget(catalog, selection.primary)?.target ?? selection.primary }
}

function resolveNamedTargets(catalog: RoutingCatalogEntry[], targets: RoutingTargetRef[]): {
  entries: RoutingCatalogEntry[]; missing: TargetExclusion[]
} {
  const entries = new Map<string, RoutingCatalogEntry>()
  const missing: TargetExclusion[] = []
  for (const target of targets) {
    const entry = resolveCatalogTarget(catalog, target)
    if (entry) entries.set(targetKey(entry.target), entry)
    else missing.push({ target, diagnostics: [issue('TARGET_UNAVAILABLE', '$.selection', 'Named target is not in the configured catalog.')] })
  }
  return { entries: [...entries.values()], missing }
}

function intentKeys(catalog: RoutingCatalogEntry[], intent: RoutingUserIntent): Set<string> {
  if (intent.kind === 'global') return new Set(catalog.map((entry) => targetKey(entry.target)))
  if (intent.kind === 'provider') return new Set(catalog.filter((entry) => entry.provider.id === intent.providerId).map((entry) => targetKey(entry.target)))
  const entry = resolveCatalogTarget(catalog, intent.target)
  return new Set(entry ? [targetKey(entry.target)] : [])
}

function fixedIntentTarget(catalog: RoutingCatalogEntry[], intent: RoutingUserIntent): RoutingTargetRef | undefined {
  return intent.kind === 'fixed' ? resolveCatalogTarget(catalog, intent.target)?.target ?? intent.target : undefined
}
