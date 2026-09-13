import type { DocumentAttachmentView, ImageAttachmentView } from './types'
import type { OfficeRevisionIntent } from './office-revision-types'

export interface SendMessagePayload {
  officeRevisionIntent?: OfficeRevisionIntent
  text: string
  images?: ImageAttachmentView[]
  documents?: DocumentAttachmentView[]
  /** Internal callers may supply a stable id for crash-safe outbox delivery. */
  messageId?: string
}
