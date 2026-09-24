import { memo, Suspense, lazy, useEffect, useState } from 'react'
import { ArrowUp, GitBranch, Pencil, RefreshCw, X } from 'lucide-react'
import type { ChatItem, ToolResultInfo } from '../store'
import { useStore } from '../store'
import { matchesDesktopShortcut } from '../desktop-keyboard'
import type { CheckpointRestoreMode } from '../../../shared/types'
import { useT } from '../i18n'
import { formatCost, formatDuration, formatTokens } from '../format'
import ToolCallCard from './ToolCallCard'
import RewindButton from './RewindButton'
import {
  FailoverMessage,
  ProviderKeyFailoverMessage,
  ProviderModelFailoverMessage,
  ProviderProtocolFailoverMessage,
  ProviderRecoveryExhaustedMessage,
  RoutingMessage
} from './experience/RoutingMessage'
import CopyButton from './CopyButton'

// Markdown 依赖 highlight.js(~700KB),懒加载拆出首屏包;未加载完先按纯文本显示
const Markdown = lazy(() => import('./Markdown'))

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

interface Props {
  sessionId?: string
  item: ChatItem
  toolResults: Record<string, ToolResultInfo>
  runningTools: Record<string, true>
  revision?: MessageRevision
  onRevise?: (revision: MessageRevision, text: string) => Promise<boolean>
  fork?: MessageFork
  onFork?: (fork: MessageFork) => void
}

type RoutingChatItem = Extract<ChatItem, {
  kind: 'routing' | 'failover' | 'provider-key-failover' | 'provider-model-failover' |
    'provider-protocol-failover' | 'provider-recovery-exhausted'
}>

export interface MessageRevision {
  checkpointId: string
  restoreMode: CheckpointRestoreMode
  kind: 'edit' | 'regenerate'
  text: string
}

export interface MessageFork {
  checkpointId: string
  text: string
}

function MessageItem({
  sessionId,
  item,
  toolResults,
  runningTools,
  revision,
  onRevise,
  fork,
  onFork
}: Props): React.JSX.Element | null {
  // useT 直接订阅 store 的语言字段,语言切换时即使 memo 也会触发重渲染
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setEditing(false)
    setDraft('')
    setBusy(false)
    setError('')
  }, [item.id])

  const submitRevision = async (text: string): Promise<void> => {
    if (!revision || !onRevise || busy || !text.trim()) return
    setBusy(true)
    setError('')
    try {
      const applied = await onRevise(revision, text.trim())
      if (applied) setEditing(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (isRoutingChatItem(item)) return <RoutingEventItem item={item} />
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg-user">
          {/* 右对齐气泡本身已表明是用户消息,不再冗余标注"你";头部仅在有回溯按钮时渲染 */}
          {item.checkpointId && (
            <div className="msg-user-head">
              <RewindButton messageId={item.checkpointId} sourceText={item.text} />
            </div>
          )}
          {editing ? (
            <div className="message-edit" data-message-editing="true">
              <textarea
                autoFocus
                className="message-edit-input"
                value={draft}
                rows={3}
                aria-label={t('editMessage')}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setEditing(false)
                    setError('')
                  } else if (matchesDesktopShortcut(event.nativeEvent, 'submitMultiline', useStore.getState().settings.desktopShortcuts)) {
                    event.preventDefault()
                    void submitRevision(draft)
                  }
                }}
              />
              <div className="message-edit-actions">
                <button
                  type="button"
                  className="message-action-button"
                  aria-label={t('cancel')}
                  title={t('cancel')}
                  disabled={busy}
                  onClick={() => {
                    setEditing(false)
                    setError('')
                  }}
                >
                  <X size={15} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="message-action-button message-action-primary"
                  aria-label={t('send')}
                  title={t('send')}
                  disabled={busy || !draft.trim()}
                  onClick={() => void submitRevision(draft)}
                >
                  <ArrowUp size={15} strokeWidth={2.2} aria-hidden="true" />
                </button>
              </div>
            </div>
          ) : item.text ? <div className="msg-user-text">{item.text}</div> : null}
          {item.attachments && item.attachments.length > 0 && (
            <div className="msg-user-attachments">
              {item.attachments.map((attachment, index) => (
                <div key={`${attachment.id}-${index}`} className="msg-user-attachment">
                  <span>图片</span>
                  <span>{attachment.mime.replace('image/', '').toUpperCase()}</span>
                  <span>{formatBytes(attachment.bytes)}</span>
                </div>
              ))}
            </div>
          )}
          {!editing && (
            <div className="message-actions">
              {fork && onFork && (
                <button
                  type="button"
                  className="message-action-button"
                  data-message-action="fork"
                  aria-label={t('forkFromMessage')}
                  title={t('forkFromMessage')}
                  onClick={() => onFork(fork)}
                >
                  <GitBranch size={14} aria-hidden="true" />
                </button>
              )}
              {revision?.kind === 'edit' && onRevise && (
                <button
                  type="button"
                  className="message-action-button"
                  data-message-action="edit"
                  aria-label={t('editMessage')}
                  title={t('editMessage')}
                  onClick={() => {
                    setDraft(item.text)
                    setError('')
                    setEditing(true)
                  }}
                >
                  <Pencil size={14} aria-hidden="true" />
                </button>
              )}
              <CopyButton text={item.text} kind="message" />
            </div>
          )}
          {error && <div className="message-revision-error" role="status">{error}</div>}
        </div>
      )

    case 'assistant': {
      const publicText = item.blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n\n')
      return (
        <div className="msg-assistant">
          {item.blocks.map((block, i) => {
            if (block.type === 'text') {
              return (
                <div key={i} className="assistant-text">
                  <Suspense fallback={<div className="md-fallback">{block.text}</div>}>
                    <Markdown text={block.text} sessionId={sessionId} messageId={item.id} />
                  </Suspense>
                </div>
              )
            }
            if (block.type === 'thinking') {
              return (
                <details key={i} className="thinking-block">
                  <summary>{t('thinkingProcess')}</summary>
                  <div className="thinking-text">{block.text}</div>
                </details>
              )
            }
            if (block.type === 'redacted_thinking') return null
            return (
              <ToolCallCard
                key={block.id || i}
                block={block}
                result={toolResults[block.id]}
                running={Boolean(runningTools[block.id])}
              />
            )
          })}
          <div className="message-actions">
            {revision?.kind === 'regenerate' && onRevise && (
              <button
                type="button"
                className="message-action-button"
                data-message-action="regenerate"
                aria-label={t('regenerateResponse')}
                title={t('regenerateResponse')}
                disabled={busy}
                onClick={() => void submitRevision(revision.text)}
              >
                <RefreshCw size={14} className={busy ? 'message-action-spin' : undefined} aria-hidden="true" />
              </button>
            )}
            <CopyButton text={publicText} kind="message" />
          </div>
          {error && <div className="message-revision-error" role="status">{error}</div>}
        </div>
      )
    }

    case 'turn-result':
      return (
        <div className={`turn-result ${item.isError ? 'turn-result-error' : ''}`}>
          {item.isError ? (
            <>
              {/* subtype 为 success/空时不显示——"本轮异常(success)"是自相矛盾的 */}
              <span className="turn-result-tag">
                {item.subtype && item.subtype !== 'success'
                  ? t('turnErrorTag', { subtype: item.subtype })
                  : t('turnErrorPlain')}
              </span>
              {item.resultText && <span className="turn-result-text">{item.resultText}</span>}
            </>
          ) : (
            <span className="turn-result-tag">
              {t('turnDone')} · {formatDuration(item.durationMs)}
              {item.usage &&
                ` · ↑${formatTokens(
                  item.usage.input + item.usage.cacheRead + item.usage.cacheCreation
                )} ↓${formatTokens(item.usage.output)}`}
              {item.costUsd !== undefined && ` · ${t('cumulative')} ${formatCost(item.costUsd)}`}
            </span>
          )}
        </div>
      )

    case 'notice':
      return <div className={`notice notice-${item.level}`}>{item.text}</div>

    default:
      return null
  }
}

function isRoutingChatItem(item: ChatItem): item is RoutingChatItem {
  return item.kind === 'routing' || item.kind === 'failover' ||
    item.kind === 'provider-key-failover' || item.kind === 'provider-model-failover' ||
    item.kind === 'provider-protocol-failover' || item.kind === 'provider-recovery-exhausted'
}

function RoutingEventItem({ item }: { item: RoutingChatItem }): React.JSX.Element {
  switch (item.kind) {
    case 'routing': return <RoutingMessage item={item} />
    case 'failover': return <FailoverMessage item={item} />
    case 'provider-key-failover': return <ProviderKeyFailoverMessage item={item} />
    case 'provider-model-failover': return <ProviderModelFailoverMessage item={item} />
    case 'provider-protocol-failover': return <ProviderProtocolFailoverMessage item={item} />
    case 'provider-recovery-exhausted': return <ProviderRecoveryExhaustedMessage item={item} />
  }
}

/**
 * memo:流式输出时 streamText 每字更新会重渲染 ChatView,但已成型的消息内容不变。
 * item 引用稳定(来自 items 数组),tool 相关在纯文本流式期间也稳定,故 memo 生效,
 * 避免每个 delta 重跑所有 MessageItem + 重解析 Markdown。
 */
export default memo(MessageItem)
