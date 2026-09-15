import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, LoaderCircle, Paperclip } from 'lucide-react'
import { modelOptionsForProvider, useStore } from '../store'
import { useT } from '../i18n'
import type { DocumentAttachmentView, ImageAttachmentView, SessionMeta } from '../../../shared/types'
import DocumentAttachmentTray from './DocumentAttachmentTray'
import ImageAttachmentTray from './ImageAttachmentTray'
import { OutboundContextPreview, useOutboundContextPreview } from './OutboundContextPreview'
import {
  filterCommandItems,
  type CommandDescriptor
} from '../commands'
import { useExperienceProjection } from './experience/ExperienceProjection'
import {
  projectedComposerCommands,
  shouldLoadProjectedPluginRegistry
} from './experience/projectedComposerCommands'
import { useComposerSubmission } from './composer/useComposerSubmission'
import { useSessionComposerDraft } from './composer/useSessionComposerDraft'
import { useSessionInputs } from './composer/useSessionInputs'
import { sessionInputIntent } from './composer/session-input-intent'
import SessionInputQueue from './composer/SessionInputQueue'
import SessionModelPicker from './composer/SessionModelPicker'
import PreparationPermission from './composer/PreparationPermission'
import TaskExecutionAuthority from './composer/TaskExecutionAuthority'
import './composer/session-inputs.css'
import { useAutosizeTextarea } from './useAutosizeTextarea'
import { COMPOSER_DRAFTS_DELETED_EVENT, isDeletedComposerDraft } from '../store/composer-draft-persistence'

interface Mention {
  start: number
  query: string
}

interface ComposerImageAttachment extends ImageAttachmentView {
  name: string
  previewUrl?: string
}

type OutboundReceiverMeta = Pick<SessionMeta, 'providerId' | 'model' | 'projectId' | 'workspaceId'>

function useComposerOutboundPreview(
  sessionId: string | null,
  meta: OutboundReceiverMeta | undefined,
  text: string,
  attachments: ComposerImageAttachment[],
  documents: DocumentAttachmentView[]
) {
  const images = useMemo(
    () => attachments.map<ImageAttachmentView>(({ name: _name, previewUrl: _previewUrl, ...image }) => image),
    [attachments]
  )
  const receiverKey = [meta?.providerId, meta?.model, meta?.projectId, meta?.workspaceId].join('\u0000')
  return { images, ...useOutboundContextPreview({ sessionId, receiverKey, text, images, documents }) }
}

/** 定位光标处正在输入的 @提及(@ 在行首或空白后,且其后无空白) */
function getMention(text: string, caret: number): Mention | null {
  let i = caret - 1
  while (i >= 0) {
    const ch = text[i]
    if (ch === '@') {
      if (i === 0 || /\s/.test(text[i - 1])) {
        const query = text.slice(i + 1, caret)
        if (/\s/.test(query)) return null
        return { start: i, query }
      }
      return null
    }
    if (/\s/.test(ch)) return null
    i--
  }
  return null
}

function isSupportedImageFile(file: File): boolean {
  const type = file.type.toLowerCase()
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type)) return true
  return /\.(png|jpe?g|gif|webp)$/i.test(file.name)
}

function clipboardImageFiles(data: DataTransfer): File[] {
  const files = [...data.files].filter(isSupportedImageFile)
  if (files.length > 0) return files
  return [...data.items].flatMap((item) => {
    if (item.kind !== 'file') return []
    const file = item.getAsFile()
    return file && isSupportedImageFile(file) ? [file] : []
  })
}

function filePath(file: File): string | undefined {
  try {
    return window.agentDesk.pathForFile(file) || undefined
  } catch {
    return (file as File & { path?: string }).path
  }
}

let imageAttachmentDrafts: Record<string, ComposerImageAttachment[]> = {}
let documentAttachmentDrafts: Record<string, DocumentAttachmentView[]> = {}

export default function Composer({ running }: { running: boolean }): React.JSX.Element {
  const t = useT()
  const projection = useExperienceProjection()
  const sendMessage = useStore((s) => s.sendMessage)
  const openLatestRewindPanel = useStore((s) => s.openLatestRewindPanel)
  const openBrowserPanel = useStore((s) => s.openBrowserPanel)
  const openDiffPanel = useStore((s) => s.openDiffPanel)
  const openFilesPanel = useStore((s) => s.openFilesPanel)
  const openWorktreePanel = useStore((s) => s.openWorktreePanel)
  const openTerminalPanel = useStore((s) => s.openTerminalPanel)
  const openPluginRegistryPanel = useStore((s) => s.openPluginRegistryPanel)
  const openSubagentPanel = useStore((s) => s.openSubagentPanel)
  const openRoutinePanel = useStore((s) => s.openRoutinePanel)
  const openMemoryPanel = useStore((s) => s.openMemoryPanel)
  const loadPluginRegistryForSlash = useStore((s) => s.loadPluginRegistryForSlash)
  const sendPluginRegistryItemToAgent = useStore((s) => s.sendPluginRegistryItemToAgent)
  const dispatchPluginAgent = useStore((s) => s.dispatchPluginAgent)
  const updateSettings = useStore((s) => s.updateSettings)
  const setModel = useStore((s) => s.setModel)
  const theme = useStore((s) => s.settings.theme)
  const zh = useStore((s) => s.settings.language === 'zh')
  const activeId = useStore((s) => s.activeId)
  const [text, setText] = useSessionComposerDraft(activeId)
  const activeSession = useStore((s) => (s.activeId ? s.sessions[s.activeId] : undefined))
  const providers = useStore((s) => s.providers)
  const pluginRegistry = useStore((s) => s.workbench.pluginRegistry)
  const pluginRegistryLoading = useStore((s) => s.workbench.pluginRegistryLoading)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const previewUrls = useRef(new Set<string>())
  const slashRegistryScanKey = useRef<string | null>(null)

  const [mention, setMention] = useState<Mention | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [slashIndex, setSlashIndex] = useState(0)
  const [attachmentsBySession, setAttachmentsBySession] = useState<Record<string, ComposerImageAttachment[]>>(
    () => imageAttachmentDrafts
  )
  const [documentsBySession, setDocumentsBySession] = useState<Record<string, DocumentAttachmentView[]>>(
    () => documentAttachmentDrafts
  )
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [ocrBusyId, setOcrBusyId] = useState<string | null>(null)
  const [uploadingAttachment, setUploadingAttachment] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [modelRequestSessionId, setModelRequestSessionId] = useState<string | null>(null)
  const currentSessionId = useRef(activeId)
  currentSessionId.current = activeId
  const attachments = activeId ? attachmentsBySession[activeId] ?? [] : []
  const documents = activeId ? documentsBySession[activeId] ?? [] : []
  const sessionInputs = useSessionInputs(activeId, running)
  const hasPendingInputs = !sessionInputs.ready || sessionInputs.records.some((record) => record.phase !== 'applied' && record.phase !== 'cancelled')
  const localInput = sessionInputIntent(text, attachments.length > 0 || documents.length > 0) !== 'message'
  const localSubmission = localInput || running || hasPendingInputs
  const outbound = useComposerOutboundPreview(activeId, activeSession?.meta, text, attachments, documents)
  useAutosizeTextarea(textareaRef, text)

  useEffect(() => {
    imageAttachmentDrafts = attachmentsBySession
  }, [attachmentsBySession])

  useEffect(() => {
    documentAttachmentDrafts = documentsBySession
  }, [documentsBySession])

  useEffect(() => {
    const clear = (): void => {
      for (const [id, items] of Object.entries(imageAttachmentDrafts)) {
        if (!isDeletedComposerDraft(id)) continue
        for (const item of items) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
        delete imageAttachmentDrafts[id]
      }
      for (const id of Object.keys(documentAttachmentDrafts)) if (isDeletedComposerDraft(id)) delete documentAttachmentDrafts[id]
      setAttachmentsBySession({ ...imageAttachmentDrafts })
      setDocumentsBySession({ ...documentAttachmentDrafts })
    }
    window.addEventListener(COMPOSER_DRAFTS_DELETED_EVENT, clear)
    return () => window.removeEventListener(COMPOSER_DRAFTS_DELETED_EVENT, clear)
  }, [])

  // 拉取文件建议(mention 变化时)
  useEffect(() => {
    if (!mention || !activeId) {
      setSuggestions([])
      return
    }
    let cancelled = false
    void window.agentDesk.suggestFiles(activeId, mention.query).then((files) => {
      if (!cancelled) {
        setSuggestions(files)
        setActiveIndex(0)
      }
    })
    return () => {
      cancelled = true
    }
  }, [mention?.query, activeId]) // eslint-disable-line react-hooks/exhaustive-deps -- only the parsed query affects suggestions

  const mentionOpen = mention !== null && suggestions.length > 0
  const slashQuery = text.startsWith('/') && !text.includes('\n') ? text.slice(1).trim().toLowerCase() : null
  const slashCommands: CommandDescriptor[] = projectedComposerCommands({
    projection,
    slashQuery,
    pluginItems: pluginRegistry?.items ?? [],
    pluginHandlers: { sendPluginRegistryItemToAgent, dispatchPluginAgent },
    commandContext: {
      t,
      modelOptions: modelOptionsForProvider(
        providers,
        activeSession?.meta.providerId ?? '',
        t('autoRoute'),
        activeSession?.meta.model
      ),
      theme,
      openLatestRewindPanel,
      openDiffPanel,
      openBrowserPanel,
      openFilesPanel,
      openWorktreePanel,
      openTerminalPanel,
      openPluginRegistryPanel,
      openSubagentPanel,
      openRoutinePanel,
      openMemoryPanel,
      updateSettings,
      setModel
    }
  })
  const slashMatches = slashQuery === null ? [] : filterCommandItems(slashQuery, slashCommands)
  const slashOpen = slashQuery !== null && slashMatches.length > 0

  useEffect(() => {
    if (!shouldLoadProjectedPluginRegistry(projection, slashQuery) || pluginRegistryLoading) return
    const key = activeId ?? '__no_session__'
    if (slashRegistryScanKey.current === key && pluginRegistry) return
    slashRegistryScanKey.current = key
    void loadPluginRegistryForSlash()
  }, [activeId, loadPluginRegistryForSlash, pluginRegistry, pluginRegistryLoading, projection, slashQuery])

  useEffect(() => {
    setSlashIndex(0)
  }, [slashQuery])

  const syncMention = (el: HTMLTextAreaElement): void => {
    setMention(getMention(el.value, el.selectionStart ?? el.value.length))
  }

  const runSlashCommand = (cmd: CommandDescriptor): void => {
    setText('')
    setMention(null)
    setSuggestions([])
    cmd.run?.()
    if (cmd.insert) setText(cmd.insert)
  }

  const revokePreview = (url: string | undefined): void => {
    if (!url) return
    URL.revokeObjectURL(url)
    previewUrls.current.delete(url)
  }

  const clearAttachments = (): void => {
    for (const attachment of attachments) revokePreview(attachment.previewUrl)
    if (!activeId) return
    setAttachmentsBySession((current) => ({ ...current, [activeId]: [] }))
    setDocumentsBySession((current) => ({ ...current, [activeId]: [] }))
  }

  const { attachmentsDisabled, sendDisabled, submit: submitWithHelper } = useComposerSubmission({
    attachments,
    documents,
    running,
    uploadingAttachment,
    text,
    documentOnlyPrompt: t('documentOnlyPrompt'),
    slashCommands,
    runSlashCommand,
    sendMessage: (payload) => hasPendingInputs ? sessionInputs.queue(payload) : sendMessage(payload, activeId ?? undefined),
    queueMessage: sessionInputs.queue,
    runLocalControl: async (text) => {
      const intent = sessionInputIntent(text)
      if (intent === 'message') return false
      if (!activeId) throw new Error('请先选择当前任务')
      if (intent === 'pause') await useStore.getState().interrupt(activeId)
      if (intent === 'palace') useStore.getState().setView('office')
      if (intent === 'model') setModelRequestSessionId(activeId)
      return true
    },
    onAccepted: () => {
      // This setter is bound to the submitted Session, including after navigation.
      setText('')
      clearAttachments()
      if (currentSessionId.current === activeId) {
        setMention(null)
        setSuggestions([])
      }
    },
    onError: (message) => {
      if (currentSessionId.current === activeId) setAttachmentError(message || null)
    }
  })

  const submit = async (): Promise<void> => {
    if (!localSubmission && outbound.rejectBlockedSend()) return
    await submitWithHelper()
  }

  const addFiles = async (files: Iterable<File>): Promise<void> => {
    if (!activeId) {
      setAttachmentError(t('attachmentSessionRequired'))
      return
    }
    const targetSessionId = activeId
    const selected = [...files]
    if (selected.length === 0) {
      setAttachmentError(t('attachmentNothingSelected'))
      return
    }
    setAttachmentError(null)
    setUploadingAttachment(true)
    try {
      for (const file of selected) {
        const localPath = filePath(file)
        if (!isSupportedImageFile(file)) {
          if (!localPath) {
            setAttachmentError(t('documentPathUnavailable', { name: file.name }))
            continue
          }
          const result = await window.agentDesk.copyDocumentAttachment(targetSessionId, localPath)
          if (!result.ok) {
            setAttachmentError(`${file.name}: ${result.error}`)
            if (result.effectStatus === 'waiting_reconciliation') await useStore.getState().refreshTaskSnapshots()
            continue
          }
          setDocumentsBySession((current) => {
            const existing = current[targetSessionId] ?? []
            if (existing.some((item) => item.id === result.id)) return current
            return { ...current, [targetSessionId]: [...existing, result] }
          })
          continue
        }

        const previewUrl = URL.createObjectURL(file)
        previewUrls.current.add(previewUrl)
        const result = localPath
          ? await window.agentDesk.copyImageAttachment(targetSessionId, localPath)
          : await window.agentDesk.saveImageAttachmentBytes(targetSessionId, {
              data: await file.arrayBuffer(),
              mime: file.type || undefined
            })
        if (!result.ok) {
          revokePreview(previewUrl)
          setAttachmentError(result.error)
          if (result.effectStatus === 'waiting_reconciliation') await useStore.getState().refreshTaskSnapshots()
          continue
        }

        setAttachmentsBySession((current) => {
          const existing = current[targetSessionId] ?? []
          if (existing.some((item) => item.id === result.id)) {
            revokePreview(previewUrl)
            return current
          }
          return {
            ...current,
            [targetSessionId]: [...existing, {
              ...result,
              name: file.name || `${result.id.slice(0, 8)}.${result.mime.split('/')[1] ?? 'image'}`,
              previewUrl
            }]
          }
        })
      }
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error))
    } finally {
      setUploadingAttachment(false)
    }
  }

  const attachSuggestedFile = async (path: string): Promise<void> => {
    if (!activeId) return
    const targetSessionId = activeId
    setAttachmentError(null)
    setUploadingAttachment(true)
    try {
      if (/\.(png|jpe?g|gif|webp)$/i.test(path)) {
        const result = await window.agentDesk.copyImageAttachment(targetSessionId, path)
        if (!result.ok) {
          setAttachmentError(result.error)
          if (result.effectStatus === 'waiting_reconciliation') await useStore.getState().refreshTaskSnapshots()
          return
        }
        setAttachmentsBySession((current) => {
          const existing = current[targetSessionId] ?? []
          if (existing.some((item) => item.id === result.id)) return current
          return { ...current, [targetSessionId]: [...existing, { ...result, name: path }] }
        })
        return
      }
      const result = await window.agentDesk.copyDocumentAttachment(targetSessionId, path)
      if (!result.ok) {
        setAttachmentError(result.error)
        if (result.effectStatus === 'waiting_reconciliation') await useStore.getState().refreshTaskSnapshots()
        return
      }
      setDocumentsBySession((current) => {
        const existing = current[targetSessionId] ?? []
        if (existing.some((item) => item.id === result.id)) return current
        return { ...current, [targetSessionId]: [...existing, result] }
      })
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error))
    } finally {
      setUploadingAttachment(false)
    }
  }

  /** OCR:提取附件文字,插到输入框光标处;失败时如实提示(不伪造) */
  const runOcr = async (attachmentId: string): Promise<void> => {
    if (!activeId) return
    const target = attachments.find((item) => item.id === attachmentId)
    if (!target) return
    setOcrBusyId(attachmentId)
    setAttachmentError(null)
    try {
      const result = await window.agentDesk.ocrImageAttachment(activeId, target.path)
      if (!result.ok || !result.text) {
        setAttachmentError(result.error || 'OCR 未识别到文字')
        return
      }
      setText((current) =>
        current
          ? `${current}\n\n[图片 ${target.name} OCR]\n${result.text}`
          : `[图片 ${target.name} OCR]\n${result.text}`
      )
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : String(err))
    } finally {
      setOcrBusyId(null)
    }
  }
  const applySuggestion = (path: string): void => {
    if (!mention) return
    const el = textareaRef.current
    const caret = el?.selectionStart ?? text.length
    const before = text.slice(0, mention.start)
    const after = text.slice(caret)
    const inserted = `@${path} `
    const next = before + inserted + after
    setText(next)
    setMention(null)
    setSuggestions([])
    void attachSuggestedFile(path)
    // 光标移到插入内容之后
    requestAnimationFrame(() => {
      if (el) {
        const pos = before.length + inserted.length
        el.focus()
        el.setSelectionRange(pos, pos)
      }
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => (i + 1) % slashMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        runSlashCommand(slashMatches[slashIndex] ?? slashMatches[0])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setText('')
        return
      }
    }
    if (mentionOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        applySuggestion(suggestions[activeIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMention(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = clipboardImageFiles(e.clipboardData)
    if (files.length === 0) return
    e.preventDefault()
    void addFiles(files)
  }

  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragActive(false)
    void addFiles(e.dataTransfer.files)
  }

  return (
    <div
      className={`composer ${dragActive ? 'composer-drag-active' : ''}`}
      onDragEnter={(e) => {
        e.preventDefault()
        setDragActive(true)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDragActive(false)
      }}
      onDrop={onDrop}
    >
      {slashOpen && (
        <div className="slash-popup">
          <div className="mention-hint">{t('slashHint')}</div>
          {slashMatches.map((cmd, i) => (
            <button
              key={cmd.id}
              className={`slash-item ${i === slashIndex ? 'active' : ''}`}
              onMouseEnter={() => setSlashIndex(i)}
              onClick={() => runSlashCommand(cmd)}
            >
              <span className="slash-title">{cmd.title}</span>
              <span className="slash-desc">{cmd.hint}</span>
            </button>
          ))}
        </div>
      )}
      {mentionOpen && (
        <div className="mention-popup">
          <div className="mention-hint">@ 引用文件 · ↑↓ 选择 · Enter 插入</div>
          {suggestions.map((path, i) => (
            <button
              key={path}
              className={`mention-item ${i === activeIndex ? 'active' : ''}`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => applySuggestion(path)}
            >
              {path}
            </button>
          ))}
        </div>
      )}
      <ImageAttachmentTray
        attachments={attachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          bytes: attachment.bytes,
          thumbnailUrl: attachment.previewUrl,
          mimeType: attachment.mime
        }))}
        disabled={attachmentsDisabled}
        ocrBusyId={ocrBusyId}
        onOcr={(id) => void runOcr(id)}
        onRemove={(id) =>
          activeId && setAttachmentsBySession((current) => {
            const existing = current[activeId] ?? []
            const target = existing.find((item) => item.id === id)
            revokePreview(target?.previewUrl)
            return { ...current, [activeId]: existing.filter((item) => item.id !== id) }
          })
        }
      />
      <DocumentAttachmentTray
        attachments={documents}
        disabled={attachmentsDisabled}
        onRemove={(id) => {
          if (!activeId) return
          setDocumentsBySession((current) => ({
            ...current,
            [activeId]: (current[activeId] ?? []).filter((item) => item.id !== id)
          }))
        }}
      />
      {attachmentError && <div className="composer-error">{attachmentError}</div>}
      {activeId && <PreparationPermission key={activeId} sessionId={activeId} running={running} />}
      {activeId && <TaskExecutionAuthority key={`authority:${activeId}`} sessionId={activeId} running={running} />}
      <SessionInputQueue
        zh={zh}
        records={sessionInputs.records} running={running} busy={sessionInputs.busy} error={sessionInputs.error}
        onApply={sessionInputs.apply} onCancel={sessionInputs.cancel} onRefresh={sessionInputs.refresh}
      />
      {modelRequestSessionId && modelRequestSessionId === activeId && <SessionModelPicker
        key={activeId} sessionId={activeId} onClose={() => setModelRequestSessionId(null)} />}
      <OutboundContextPreview manifest={outbound.manifest} error={outbound.error} />
      <div className="composer-row">
        <input
          ref={fileInputRef}
          className="composer-file-input"
          type="file"
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp,text/*,.md,.mdx,.json,.jsonl,.yaml,.yml,.toml,.xml,.csv,.tsv,.js,.jsx,.ts,.tsx,.css,.scss,.html,.py,.go,.rs,.java,.kt,.kts,.c,.h,.cpp,.hpp,.cs,.sh,.ps1,.sql"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            void addFiles(event.currentTarget.files ?? [])
            event.currentTarget.value = ''
          }}
        />
        <button
          type="button"
          className="composer-attach"
          aria-label={t('addAttachment')}
          title={t('addAttachment')}
          disabled={!activeId || attachmentsDisabled}
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip size={18} strokeWidth={1.9} aria-hidden="true" />
        </button>
        <textarea
          ref={textareaRef}
          className="composer-input"
          placeholder={running ? zh ? '补充要求会保存到当前任务；也可以说“暂停这个任务”' : 'Additions are saved to this task. You can also say “pause this task”.' : t('composerPlaceholder')}
          value={text}
          rows={1}
          onChange={(e) => {
            setText(e.target.value)
            syncMention(e.target)
          }}
          onKeyUp={(e) => syncMention(e.currentTarget)}
          onClick={(e) => syncMention(e.currentTarget)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          data-composer-autosize="true"
          autoFocus
        />
        <button
          className="btn btn-primary composer-send"
          aria-label={uploadingAttachment ? zh ? '添加中' : 'Adding' : running && !localInput ? zh ? '保存补充要求' : 'Save addition' : t('send')}
          title={uploadingAttachment ? zh ? '添加中' : 'Adding' : running && !localInput ? zh ? '保存补充要求' : 'Save addition' : t('send')}
          onClick={() => void submit()}
          disabled={sendDisabled || (!localSubmission && outbound.sendDisabled(false))}
        >
          {uploadingAttachment
            ? <LoaderCircle className="composer-send-spinner" size={17} aria-hidden="true" />
            : <ArrowUp size={17} strokeWidth={2.2} aria-hidden="true" />}
        </button>
      </div>
    </div>
  )
}
