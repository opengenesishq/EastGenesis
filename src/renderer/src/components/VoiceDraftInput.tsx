import { useEffect, useRef, useState } from 'react'
import { Mic, Square, X, RotateCcw, Settings2 } from 'lucide-react'
import type { VoiceDraftApi, VoiceInputPreparation } from '../../../shared/voice-input-types'
import { VOICE_INPUT_MAX_BYTES, VOICE_INPUT_MAX_DURATION_MS } from '../../../shared/voice-input-types'
import './voice-draft-input.css'
import { useStore } from '../store'

export interface VoiceDraftInputProps {
  api?: VoiceDraftApi
  language?: 'zh' | 'en'
  /** Use the current task id, or a stable id for the unsent new-task draft. */
  contextId: string
  disabled?: boolean
  onInsert(text: string): void
  onOpenSettings?: () => void
  onOpenChange?(open: boolean): void
}
type Phase = 'idle' | 'starting' | 'recording' | 'ready' | 'transcribing' | 'preview'

/** Audio exists only in memory. Inserting text never submits the task. */
export default function VoiceDraftInput({ contextId, disabled, onInsert, onOpenSettings, onOpenChange, api: suppliedApi, language }: VoiceDraftInputProps): React.JSX.Element {
  const defaultLanguage = useStore((state) => state.settings.language)
  const zh = (language ?? defaultLanguage) !== 'en'
  const api = suppliedApi ?? window.agentDesk
  const tr = (chinese: string, english: string): string => zh ? chinese : english
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [preparation, setPreparation] = useState<VoiceInputPreparation | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [audio, setAudio] = useState<Blob | null>(null)
  const [audioUrl, setAudioUrl] = useState('')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const generation = useRef(0)
  const recorder = useRef<MediaRecorder | null>(null)
  const microphone = useRef<MediaStream | null>(null)
  const prepared = useRef<VoiceInputPreparation | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const duration = useRef(0)
  const mounted = useRef(true)
  const notifyOpen = useRef(onOpenChange); notifyOpen.current = onOpenChange
  useEffect(() => { notifyOpen.current?.(open) }, [open])
  const stopMicrophone = (): void => {
    if (timer.current) { clearInterval(timer.current); timer.current = null }
    microphone.current?.getTracks().forEach((track) => track.stop())
    microphone.current = null
  }
  const release = (): void => {
    generation.current++
    const current = recorder.current; recorder.current = null
    if (current && current.state !== 'inactive') current.stop()
    stopMicrophone()
    if (prepared.current) void api.cancelVoiceInput(prepared.current.preparationId).catch(() => undefined)
    prepared.current = null
  }
  const reset = (close = false): void => {
    release(); setPhase('idle'); setPreparation(null); setAudio(null); setText(''); setElapsed(0); setError(''); setWarning('')
    if (close) setOpen(false)
  }
  useEffect(() => {
    mounted.current = true
    reset(true)
    return () => { mounted.current = false; release(); notifyOpen.current?.(false) }
    // The task identity owns all microphone and request resources.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextId])
  useEffect(() => {
    if (!audio) { setAudioUrl(''); return }
    const url = URL.createObjectURL(audio); setAudioUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [audio])
  const current = (id: number): boolean => mounted.current && generation.current === id

  async function start(): Promise<void> {
    if (disabled || phase === 'starting' || phase === 'recording' || phase === 'transcribing') return
    reset(); setOpen(true); setPhase('starting')
    const id = generation.current
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('当前环境无法录音，请检查麦克风权限或使用桌面应用。')
      const target = await api.prepareVoiceInput(contextId)
      if (!current(id)) { void api.cancelVoiceInput(target.preparationId); return }
      prepared.current = target; setPreparation(target)
      if (!await api.requestVoiceMicrophonePermission()) throw new Error('麦克风权限未开启，请在系统隐私设置中允许 EastGenesis 使用麦克风。')
      if (!current(id)) return
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
      if (!current(id)) { stream.getTracks().forEach((track) => track.stop()); return }
      microphone.current = stream
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type))
      if (!mimeType) throw new Error('当前环境没有支持的录音编码格式。')
      const recording = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 })
      recorder.current = recording
      const chunks: Blob[] = []
      let bytes = 0
      const began = performance.now()
      recording.ondataavailable = (event): void => {
        if (!current(id) || !event.data.size) return
        bytes += event.data.size
        if (bytes > VOICE_INPUT_MAX_BYTES) { release(); setPhase('idle'); setError('录音超过 20 MB，请缩短后重新录制。'); return }
        chunks.push(event.data)
      }
      recording.onerror = (): void => {
        if (!current(id)) return
        release(); setPhase('idle'); setError('麦克风录音失败，请检查设备后重新录制。')
      }
      recording.onstop = (): void => {
        if (!current(id)) return
        duration.current = Math.min(VOICE_INPUT_MAX_DURATION_MS, Math.max(100, performance.now() - began))
        stopMicrophone(); recorder.current = null
        if (!chunks.length) { setPhase('idle'); setError('没有录到声音，请重新录制。'); return }
        setAudio(new Blob(chunks, { type: recording.mimeType })); setElapsed(duration.current); setPhase('ready')
      }
      recording.start(250); setPhase('recording')
      timer.current = setInterval(() => {
        if (!current(id)) return
        const ms = Math.min(VOICE_INPUT_MAX_DURATION_MS, performance.now() - began)
        setElapsed(ms)
        if (ms >= VOICE_INPUT_MAX_DURATION_MS && recording.state !== 'inactive') recording.stop()
      }, 200)
    } catch (cause) {
      if (!current(id)) return
      release(); setPhase('idle'); setError(cause instanceof Error ? cause.message : '无法启动麦克风。')
    }
  }
  async function transcribe(): Promise<void> {
    const target = prepared.current
    if (!audio || !target || phase === 'transcribing' || disabled) return
    const id = generation.current
    setPhase('transcribing'); setError(''); setWarning('')
    try {
      const bytes = await audio.arrayBuffer()
      if (!current(id)) return
      const result = await api.transcribeVoiceInput({ preparationId: target.preparationId,
        requestId: crypto.randomUUID(), audio: bytes, mimeType: audio.type, durationMs: duration.current })
      if (!current(id) || result.contextId !== contextId) return
      setText(result.text); setPhase('preview')
    } catch (cause) {
      if (!current(id)) return
      setPhase('ready'); setError(cause instanceof Error ? cause.message : '语音转写失败，可重试。')
      setWarning('录音仍保留在当前窗口，手动重试可能产生新的转写费用。')
    }
  }
  function insert(): void {
    if (!text.trim() || disabled || prepared.current?.contextId !== contextId) return
    onInsert(text.trim()); reset(true)
  }
  return <div className="voice-draft-input" data-voice-draft-input>
    <button type="button" className="btn btn-ghost btn-icon-sm" data-voice-start disabled={disabled}
      title={tr('听写到草稿', 'Dictate into draft')} aria-label={tr('听写到草稿', 'Dictate into draft')} aria-expanded={open} onClick={() => { if (open) reset(true); else void start() }}><Mic size={16} /></button>
    {open && <section className="voice-draft-panel" data-voice-phase={phase} role="region" aria-label={tr('语音输入到当前草稿', 'Voice input for the current draft')}>
      <header><strong>{tr('语音输入', 'Voice input')}</strong><button type="button" className="btn btn-ghost btn-icon-sm" aria-label={tr('关闭语音输入', 'Close voice input')} data-voice-close onClick={() => reset(true)}><X size={15} /></button></header>
      {preparation && <p className="voice-draft-target">{preparation.providerName} · {preparation.model}</p>}
      <p className="voice-draft-hint">{tr('转写后先预览，确认插入当前草稿；发送由你操作。', 'Preview and insert the transcription into your draft. You choose when to send.')}</p>
      {phase === 'starting' && <p role="status">{tr('正在准备麦克风…', 'Preparing microphone…')}</p>}
      {phase === 'recording' && <div className="voice-draft-recording" role="status"><span className="voice-draft-dot" />{tr('正在录音', 'Recording')} {Math.floor(elapsed / 1000)} / 120 {tr('秒', 's')}</div>}
      {audioUrl && <audio controls src={audioUrl} aria-label={tr('回听当前录音', 'Play current recording')} />}
      {phase === 'transcribing' && <p role="status">{tr('正在转写，可关闭取消…', 'Transcribing. Close to cancel…')}</p>}
      {phase === 'preview' && <label>{tr('转写预览', 'Transcription preview')}<textarea className="input" data-voice-preview value={text} maxLength={32_000} onChange={(event) => setText(event.target.value)} rows={5} /></label>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {warning && <p className="voice-draft-hint">{warning}</p>}
      <footer>
        {phase === 'recording' && <button type="button" className="btn btn-primary btn-sm" data-voice-stop onClick={() => recorder.current?.stop()}><Square size={13} />{tr('停止录音', 'Stop recording')}</button>}
        {phase === 'ready' && <button type="button" className="btn btn-primary btn-sm" data-voice-transcribe disabled={disabled} onClick={() => void transcribe()}>{tr('转成文字', 'Transcribe')}</button>}
        {phase === 'preview' && <button type="button" className="btn btn-primary btn-sm" data-voice-insert disabled={disabled || !text.trim()} onClick={insert}>{tr('插入当前草稿', 'Insert into draft')}</button>}
        {['idle', 'ready', 'preview'].includes(phase) && <button type="button" className="btn btn-ghost btn-sm" data-voice-retry-record disabled={disabled} onClick={() => void start()}><RotateCcw size={13} />{audio ? tr('重新录音', 'Record again') : tr('开始录音', 'Start recording')}</button>}
        {onOpenSettings && phase !== 'recording' && phase !== 'starting' && phase !== 'transcribing' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { reset(true); onOpenSettings() }}><Settings2 size={13} />{tr('语音设置', 'Voice settings')}</button>}
      </footer>
      {phase === 'ready' && <p className="voice-draft-hint">{tr('点击转写会把本次录音交给上方厂商处理，按该厂商规则计费。', 'Transcribing uploads this recording to the provider above. Their billing terms apply.')}</p>}
    </section>}
  </div>
}
