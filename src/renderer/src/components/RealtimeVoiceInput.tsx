import { useEffect, useRef, useState } from 'react'
import { AudioLines, Mic, Pause, Square, VolumeX, X } from 'lucide-react'
import type { RealtimeVoicePreparation } from '../../../shared/voice-input-types'
import type { SessionInputRecord } from '../../../shared/session-input-types'
import { useStore, type SessionState } from '../store'
import { createVoiceReplyPlayback } from './voice-reply-playback'
import { selectLocalSpeechVoice } from './local-speech'
import './voice-draft-input.css'

function replies(session?: SessionState): string[] {
  return (session?.items ?? []).flatMap(item => item.kind === 'assistant'
    ? [item.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()].filter(Boolean) : [])
}

export default function RealtimeVoiceInput({ sessionId, disabled, onInputsChanged, onOpenChange }: {
  sessionId: string; disabled?: boolean; onInputsChanged?(): void; onOpenChange?(open: boolean): void
}): React.JSX.Element {
  const zh = useStore(state => state.settings.language) !== 'en'
  const tr = (cn: string, en: string): string => zh ? cn : en
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'ready' | 'starting' | 'active'>('idle')
  const [prepared, setPrepared] = useState<RealtimeVoicePreparation>()
  const [speaking, setSpeaking] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [mic, setMic] = useState(false)
  const [error, setError] = useState('')
  const [speechError, setSpeechError] = useState('')
  const [lastText, setLastText] = useState('')
  const [records, setRecords] = useState<SessionInputRecord[]>([])
  const [elapsed, setElapsed] = useState(0)
  const mounted = useRef(true)
  const generation = useRef(0)
  const call = useRef<RealtimeVoicePreparation>()
  const active = useRef(false)
  const stream = useRef<MediaStream>()
  const recorder = useRef<MediaRecorder>()
  const audio = useRef<AudioContext>()
  const timer = useRef<ReturnType<typeof setInterval>>()
  const pump = useRef<ReturnType<typeof setInterval>>()
  const segmentBusy = useRef(false)
  const drainBusy = useRef(false)
  const finishSentence = useRef<() => void>(() => undefined)
  const sequence = useRef(0)
  const seenReplies = useRef(new Map<string, number>())
  const onChanged = useRef(onInputsChanged); onChanged.current = onInputsChanged
  const notifyOpen = useRef(onOpenChange); notifyOpen.current = onOpenChange
  const readReplies = useRef<() => void>(() => undefined)
  const recordingHasVoice = useRef(false)
  const playback = useRef<ReturnType<typeof createVoiceReplyPlayback>>()
  const current = (id: number): boolean => mounted.current && generation.current === id
  useEffect(() => { notifyOpen.current?.(open) }, [open])

  function stopLocal(): RealtimeVoicePreparation | undefined {
    generation.current++; active.current = false
    const target = call.current; call.current = undefined
    if (timer.current) clearInterval(timer.current)
    if (pump.current) clearInterval(pump.current)
    timer.current = undefined; pump.current = undefined
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop()
    recorder.current = undefined
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = undefined
    void audio.current?.close().catch(() => undefined); audio.current = undefined
    playback.current?.interrupt(); playback.current = undefined
    segmentBusy.current = false; drainBusy.current = false
    if (mounted.current) { setPhase('idle'); setMic(false); setTranscribing(false); setSpeaking(false); setPrepared(undefined) }
    return target
  }
  async function stop(command?: 'pause' | 'cancel'): Promise<void> {
    const target = stopLocal()
    if (!target) return
    try {
      if (command) await window.agentDesk.controlRealtimeVoice({ callId: target.callId, command })
      else await window.agentDesk.stopRealtimeVoice(target.callId)
      onChanged.current?.()
      const saved = await window.agentDesk.listSessionInputs(target.sessionId)
      if (mounted.current) setRecords(previous => saved.filter(record => previous.some(own => own.id === record.id)))
      if (command) await useStore.getState().syncSession(target.sessionId)
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const target = stopLocal()
      notifyOpen.current?.(false)
      if (target) void window.agentDesk.stopRealtimeVoice(target.callId).catch(() => undefined)
    }
    // A component is keyed to one task and owns its microphone, speech and server call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  async function prepare(): Promise<void> {
    if (disabled || call.current) return
    setOpen(true); setPhase('preparing'); setError(''); setSpeechError(''); setLastText(''); setRecords([])
    const id = ++generation.current
    try {
      const target = await window.agentDesk.prepareRealtimeVoice(sessionId)
      if (!current(id)) { void window.agentDesk.stopRealtimeVoice(target.callId).catch(() => undefined); return }
      call.current = target; setPrepared(target); setPhase('ready')
    } catch (cause) {
      if (current(id)) { setPhase('idle'); setError(cause instanceof Error ? cause.message : String(cause)) }
    }
  }
  async function start(): Promise<void> {
    const target = call.current
    if (!target || phase !== 'ready') return
    const id = generation.current
    setPhase('starting'); setError('')
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error(tr('当前环境不支持录音。', 'Recording is unavailable in this environment.'))
      if (!await window.agentDesk.requestVoiceMicrophonePermission()) throw new Error(tr('请在系统设置中允许麦克风访问。', 'Allow microphone access in system settings.'))
      if (!current(id)) return
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
      if (!current(id)) { microphone.getTracks().forEach(track => track.stop()); return }
      stream.current = microphone
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type))
      if (!mimeType) throw new Error(tr('没有支持的录音编码。', 'No supported recording codec.'))
      const context = new AudioContext(); audio.current = context
      await context.resume()
      const analyser = context.createAnalyser(); analyser.fftSize = 512
      context.createMediaStreamSource(microphone).connect(analyser)
      const waveform = new Float32Array(analyser.fftSize)
      await window.agentDesk.startRealtimeVoice(target.callId)
      if (!current(id)) { void window.agentDesk.stopRealtimeVoice(target.callId).catch(() => undefined); return }
      active.current = true; sequence.current = 0
      seenReplies.current = new Map()
      for (const text of replies(useStore.getState().sessions[sessionId])) seenReplies.current.set(text, (seenReplies.current.get(text) ?? 0) + 1)
      playback.current = createVoiceReplyPlayback({
        speak: (text, done) => {
          if (!window.speechSynthesis) { done(tr('系统语音播报不可用。', 'System speech is unavailable.')); return }
          const selectedVoice = selectLocalSpeechVoice(window.speechSynthesis.getVoices(), useStore.getState().settings.voiceInput, zh ? 'zh' : 'en')
          const voice = selectedVoice.voice
          if (selectedVoice.fallback) setSpeechError(tr('原声线不可用，已使用本地系统备选声音；可在语音设置中重新选择。', 'The selected voice is unavailable; using a local fallback. Choose another voice in settings.'))
          if (!voice) { done(tr('没有可用的本地系统声音，请安装系统语音包。', 'No local system voice is available. Install a system voice.')); return }
          const utterance = new SpeechSynthesisUtterance(text); utterance.voice = voice; utterance.lang = voice.lang
          utterance.rate = selectedVoice.rate
          utterance.onend = () => done()
          utterance.onerror = event => done(`${tr('语音播报失败', 'Speech failed')}: ${event.error}`)
          window.speechSynthesis.speak(utterance)
        },
        cancel: () => window.speechSynthesis?.cancel()
      }, (value, issue) => {
        if (!current(id)) return
        setSpeaking(value)
        if (issue) setSpeechError(issue)
        // Half duplex: do not feed synthesized speech back to the transcriber.
        microphone.getAudioTracks().forEach(track => { track.enabled = !value })
        setMic(!value && !segmentBusy.current)
        if (value && recorder.current?.state === 'recording') recorder.current.stop()
      })
      const began = Date.now()
      let recordingBegan = 0, lastVoice = 0, heardVoice = false, forceSubmit = false
      const beginSegment = (): void => {
        if (!current(id) || !active.current || segmentBusy.current || playback.current?.speaking || recorder.current) return
        recordingBegan = performance.now(); lastVoice = recordingBegan; heardVoice = false; forceSubmit = false; recordingHasVoice.current = false
        const recording = new MediaRecorder(microphone, { mimeType, audioBitsPerSecond: 64_000 })
        recorder.current = recording
        const chunks: Blob[] = []
        let bytes = 0
        recording.ondataavailable = event => {
          if (!current(id) || !event.data.size) return
          bytes += event.data.size
          if (bytes > target.maxBytes) { setError(tr('录音过大，会话已停止。', 'Recording is too large. Voice stopped.')); void stop(); return }
          chunks.push(event.data)
        }
        recording.onerror = () => { if (current(id)) { setError(tr('录音失败，请检查麦克风。', 'Recording failed. Check your microphone.')); void stop() } }
        recording.onstop = () => {
          if (!current(id)) return
          recorder.current = undefined
          const durationMs = Math.min(target.maxSegmentDurationMs, Math.max(100, performance.now() - recordingBegan))
          if ((!heardVoice && !forceSubmit) || playback.current?.speaking || !chunks.length) return
          segmentBusy.current = true; setTranscribing(true); setMic(false)
          microphone.getAudioTracks().forEach(track => { track.enabled = false })
          const segmentId = crypto.randomUUID(), segmentSequence = sequence.current++
          void (async () => {
            try {
              const data = await new Blob(chunks, { type: recording.mimeType }).arrayBuffer()
              if (!current(id)) return
              const receipt = await window.agentDesk.submitRealtimeVoiceSegment({ callId: target.callId, segmentId,
                sequence: segmentSequence, audio: data, mimeType: recording.mimeType, durationMs })
              if (!current(id)) return
              if (receipt.sessionId !== sessionId || receipt.callId !== target.callId || receipt.segmentId !== segmentId) throw new Error(tr('语音回执身份不一致。', 'Voice receipt identity mismatch.'))
              setLastText(receipt.text)
              if (receipt.input) setRecords(previous => [...previous.filter(record => record.id !== receipt.input!.id), receipt.input!])
              onChanged.current?.()
              if (receipt.action !== 'input') { stopLocal(); await useStore.getState().syncSession(sessionId); return }
            } catch (cause) {
              if (current(id)) { setError(cause instanceof Error ? cause.message : String(cause)); await stop() }
            } finally {
              if (current(id)) {
                segmentBusy.current = false; recordingHasVoice.current = false; setTranscribing(false); setMic(!playback.current?.speaking)
                microphone.getAudioTracks().forEach(track => { track.enabled = !playback.current?.speaking })
              }
            }
          })()
        }
        recording.start(250)
      }
      finishSentence.current = () => { if (recorder.current?.state === 'recording' && performance.now() - recordingBegan >= 100) { forceSubmit = true; recordingHasVoice.current = true; recorder.current.stop() } }
      setPhase('active'); setMic(true)
      timer.current = setInterval(() => {
        if (!current(id)) return
        setElapsed(Math.floor((Date.now() - began) / 1000))
        if (Date.now() >= target.expiresAt) { void stop(); return }
        readReplies.current()
        beginSegment()
        if (recorder.current?.state !== 'recording') return
        analyser.getFloatTimeDomainData(waveform)
        const rms = Math.sqrt(waveform.reduce((sum, sample) => sum + sample * sample, 0) / waveform.length)
        const at = performance.now()
        if (rms > 0.018) { heardVoice = true; recordingHasVoice.current = true; lastVoice = at }
        if ((heardVoice && at - lastVoice > 900 && at - recordingBegan > 700) || at - recordingBegan >= target.maxSegmentDurationMs - 250) recorder.current.stop()
      }, 100)
      pump.current = setInterval(() => {
        if (!current(id) || drainBusy.current) return
        drainBusy.current = true
        void window.agentDesk.drainRealtimeVoice(target.callId).then(updated => {
          if (!current(id)) return
          setRecords(updated); onChanged.current?.()
          const uncertain = updated.find(record => record.phase === 'needs_reconciliation')
          if (uncertain) { setError(uncertain.error ?? tr('提交结果待核对。', 'Submission needs reconciliation.')); void stop() }
        }).catch(cause => {
          if (current(id)) { setError(cause instanceof Error ? cause.message : String(cause)); void stop() }
        }).finally(() => { if (current(id)) drainBusy.current = false })
      }, 800)
      beginSegment()
    } catch (cause) {
      if (current(id)) { setError(cause instanceof Error ? cause.message : String(cause)); await stop() }
    }
  }

  readReplies.current = () => {
    const state = useStore.getState()
    if (!active.current || state.activeId !== sessionId) {
      if (active.current && state.activeId !== sessionId) void stop()
      return
    }
    const session = state.sessions[sessionId]
    if (!session || session.meta.status === 'closed') { void stop(); return }
    if (['running', 'starting'].includes(session.meta.status) || segmentBusy.current || recordingHasVoice.current) return
    const counts = new Map<string, number>()
    for (const text of replies(session)) {
      const count = (counts.get(text) ?? 0) + 1; counts.set(text, count)
      if (count > (seenReplies.current.get(text) ?? 0)) playback.current?.enqueue(text)
    }
    seenReplies.current = counts
  }
  useEffect(() => useStore.subscribe(() => readReplies.current()), [sessionId])

  return <div className="voice-draft-input" data-realtime-voice>
    <button type="button" className="btn btn-ghost btn-icon-sm" disabled={disabled && !open} title={tr('持续语音会话', 'Voice conversation')} aria-label={tr('持续语音会话', 'Voice conversation')} aria-expanded={open}
      onClick={() => { if (open) { void stop(); setOpen(false) } else void prepare() }}><AudioLines size={17} /></button>
    {open && <section className="voice-draft-panel realtime-voice-panel" role="region" aria-label={tr('当前任务语音会话', 'Voice conversation for this task')} data-realtime-phase={phase}>
      <header><strong>{tr('持续语音会话', 'Voice conversation')}</strong><button type="button" className="btn btn-ghost btn-icon-sm" aria-label={tr('结束并关闭', 'End and close')} onClick={() => { void stop(); setOpen(false) }}><X size={15} /></button></header>
      {prepared && <p className="voice-draft-target">{prepared.providerName} · {prepared.model}</p>}
      <p className="voice-draft-hint">{tr('开启后，每句话自动转写并提交到当前任务；回答用本地系统声音播报。停顿约一秒发送，也可按“说完一句”。', 'Once started, each phrase is transcribed and sent to this task. Replies use a local system voice. Pause for about a second, or finish a phrase manually.')}</p>
      {phase === 'ready' && <p className="voice-draft-hint">{tr('录音会发送给上方转写厂商并按其规则计费；执行沿用当前任务权限。一次会话最长 15 分钟。', 'Recordings go to the provider above and may incur charges. Existing task permissions apply. A call lasts up to 15 minutes.')}</p>}
      {['preparing', 'starting'].includes(phase) && <p role="status">{tr('正在准备语音会话…', 'Preparing voice…')}</p>}
      {phase === 'active' && <div className="realtime-voice-status" role="status"><span><Mic size={14} />{mic ? tr('麦克风：正在聆听', 'Microphone: listening') : tr('麦克风：暂歇', 'Microphone: paused')}</span><span>{speaking ? tr('正在播报', 'Speaking') : transcribing ? tr('正在转写', 'Transcribing') : tr('等待说话', 'Waiting for speech')} · {elapsed}s</span></div>}
      {lastText && <p className="realtime-voice-transcript">{lastText}</p>}
      {records.length > 0 && <p className="voice-draft-hint">{tr('已提交', 'Submitted')} {records.filter(record => record.phase === 'applied').length} · {tr('排队', 'Queued')} {records.filter(record => record.phase === 'queued').length} · {tr('待核对', 'Needs review')} {records.filter(record => record.phase === 'needs_reconciliation' || record.phase === 'dispatching').length}</p>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {speechError && <p role="alert">{speechError}</p>}
      <footer>
        {phase === 'ready' && <button type="button" className="btn btn-primary btn-sm" onClick={() => void start()}>{tr('开启连续交谈', 'Start conversation')}</button>}
        {phase === 'idle' && <button type="button" className="btn btn-primary btn-sm" onClick={() => void prepare()}>{tr('重新开始', 'Start again')}</button>}
        {phase === 'active' && <>
          <button type="button" className="btn btn-primary btn-sm" disabled={!mic || transcribing} onClick={() => finishSentence.current()}>{tr('说完一句', 'Finish phrase')}</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!speaking} onClick={() => playback.current?.interrupt()}><VolumeX size={14} />{tr('打断播报', 'Interrupt speech')}</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void stop('pause')}><Pause size={14} />{tr('暂停任务', 'Pause task')}</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void stop('cancel')}>{tr('取消本轮任务', 'Cancel this turn')}</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void stop()}><Square size={14} />{tr('结束语音', 'End voice')}</button>
        </>}
        {phase !== 'active' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void stop(); setOpen(false); useStore.getState().setShowSettings(true, 'voice') }}>{tr('语音设置', 'Voice settings')}</button>}
      </footer>
      <p className="voice-draft-hint">{tr('播报和转写时暂停收音；可打断播报继续说。结束语音会撤回尚未提交的语音补充，已经执行的任务继续运行。', 'Listening pauses during speech and transcription. Interrupt playback to speak. Ending voice withdraws unsent voice additions; accepted work continues.')}</p>
    </section>}
  </div>
}
