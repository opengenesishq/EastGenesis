import type { OfficeRevisionApi } from '../shared/office-revision-types'
import { invokeAppFeature } from './app-feature'

export const officeRevisionApi: OfficeRevisionApi = {
  inspectOfficeArtifact: (input) => invokeAppFeature('office-revision', 'inspect', input),
  planOfficeRevision: (input) => invokeAppFeature('office-revision', 'plan', input)
}
