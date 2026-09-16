import type { DocumentAttachmentView, ImageAttachmentView } from './types'
import type { OfficeRevisionIntent } from './office-revision-types'
import type { SessionRequirementRevisionIntent } from './session-requirement-revision'

export interface SendMessagePayload {
  officeRevisionIntent?: OfficeRevisionIntent
  requirementRevisionIntent?: SessionRequirementRevisionIntent
  text: string
  images?: ImageAttachmentView[]
  documents?: DocumentAttachmentView[]
  /** Internal callers may supply a stable id for crash-safe outbox delivery. */
  messageId?: string
}
