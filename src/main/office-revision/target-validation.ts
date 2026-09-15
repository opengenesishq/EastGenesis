import { isAbsolute, resolve } from 'node:path'
import type { OfficeRevisionEffectTarget } from '../../shared/office-revision-types'
import { normalizeOfficeDraft, officeDigest, officeRecord, officeText } from './input'

export function isOfficeRevisionTarget(value: unknown): value is OfficeRevisionEffectTarget {
  try {
    const raw = officeRecord(value, ['kind', 'schemaVersion', 'artifactKind', 'sessionId', 'projectId', 'goalId', 'workItemId', 'businessLineId',
      'baseArtifactId', 'baseDigest', 'baseVersion', 'lineageId', 'planId', 'planDigest', 'operations', 'unchangedScopeDigest',
      'rootPath', 'rootIdentity', 'relativePath', 'workspacePath', 'expectedSha256', 'expectedBytes', 'mediaType', 'title'])
    if (raw.kind !== 'office_artifact_revision' || raw.schemaVersion !== 1 || !['document', 'spreadsheet', 'presentation'].includes(String(raw.artifactKind))) return false
    for (const key of ['sessionId', 'projectId', 'workItemId', 'lineageId', 'planId', 'title', 'mediaType']) officeText(raw[key], key)
    for (const key of ['goalId', 'businessLineId']) if (raw[key] !== undefined) officeText(raw[key], key)
    for (const key of ['baseDigest', 'planDigest', 'unchangedScopeDigest', 'expectedSha256']) officeDigest(raw[key])
    const root = officeText(raw.rootPath, 'rootPath'), path = officeText(raw.workspacePath, 'workspacePath'), relative = officeText(raw.relativePath, 'relativePath')
    if (!validOutputPath(root, relative, path)) return false
    const identity = officeRecord(raw.rootIdentity, ['device', 'inode'])
    officeText(identity.device, 'device'); officeText(identity.inode, 'inode')
    const draft = normalizeOfficeDraft({ baseArtifactId: raw.baseArtifactId, expectedDigest: raw.baseDigest, operations: raw.operations })
    const operationKind = raw.artifactKind === 'document' ? 'replaceParagraphText' : raw.artifactKind === 'presentation' ? 'replaceSlideText' : 'setCellValue'
    if (draft.operations.some((operation) => operation.kind !== operationKind)) return false
    if (raw.artifactKind === 'presentation' && draft.operations.length !== 1) return false
    return Number.isSafeInteger(raw.baseVersion) && Number(raw.baseVersion) >= 1 && Number.isSafeInteger(raw.expectedBytes) && Number(raw.expectedBytes) > 0
  } catch { return false }
}

function validOutputPath(root: string, relative: string, path: string): boolean {
  return isAbsolute(root) && isAbsolute(path) && !isAbsolute(relative) && !relative.split(/[\\/]/).includes('..') && resolve(root, relative) === path
}
