import { useRef, useState } from 'react'
import type {
  DocumentAttachmentView,
  ImageAttachmentView,
  SendMessagePayload
} from '../../../../shared/types'
import type { CommandDescriptor } from '../../commands'

type SubmissionAttachment = ImageAttachmentView & { name: string; previewUrl?: string }

interface ComposerSubmissionOptions {
  attachments: SubmissionAttachment[]
  documents: DocumentAttachmentView[]
  running: boolean
  uploadingAttachment: boolean
  text: string
  documentOnlyPrompt: string
  slashCommands: CommandDescriptor[]
  runSlashCommand(command: CommandDescriptor): void
  sendMessage(input: SendMessagePayload): Promise<void>
  queueMessage?(input: SendMessagePayload): Promise<void>
  runLocalControl?(text: string): Promise<boolean>
  onAccepted(): void
  onError(message: string): void
}

export function useComposerSubmission(options: ComposerSubmissionOptions) {
  const [sending, setSending] = useState(false)
  const inFlight = useRef(false)

  const submit = async (): Promise<void> => {
    if (inFlight.current || sending) return
    const trimmed = options.text.trim()
    if (!trimmed && options.attachments.length === 0 && options.documents.length === 0) return
    const images = options.attachments.map<ImageAttachmentView>(
      ({ name: _name, previewUrl: _previewUrl, ...image }) => image
    )
    setSending(true)
    inFlight.current = true
    options.onError('')
    try {
      if (options.attachments.length === 0 && options.documents.length === 0) {
        if (await options.runLocalControl?.(trimmed)) {
          options.onAccepted()
          return
        }
        const slash = options.slashCommands.find((command) => command.title.toLowerCase() === trimmed.toLowerCase())
        if (slash) {
          options.runSlashCommand(slash)
          return
        }
      }
      const send = options.running ? options.queueMessage : options.sendMessage
      if (!send) throw new Error('任务仍在运行，请等待本轮完成')
      await send({
        text: trimmed || (options.documents.length > 0 ? options.documentOnlyPrompt : ''),
        images,
        documents: options.documents
      })
      options.onAccepted()
    } catch (error) {
      options.onError(error instanceof Error ? error.message : String(error))
    } finally {
      inFlight.current = false
      setSending(false)
    }
  }

  return {
    attachmentsDisabled: options.uploadingAttachment || sending,
    sendDisabled: sending || options.uploadingAttachment ||
      (!options.text.trim() && options.attachments.length === 0 && options.documents.length === 0),
    submit
  }
}
