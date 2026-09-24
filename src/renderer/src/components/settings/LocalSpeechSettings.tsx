import { useEffect, useRef, useState } from 'react'
import type { VoiceInputSettings } from '../../../../shared/voice-input-types'
import { selectLocalSpeechVoice } from '../local-speech'
import { PreferenceRow } from './DesktopPreferences'
export default function LocalSpeechSettings({ value, zh, onChange }: { value?: VoiceInputSettings; zh: boolean; onChange(value: VoiceInputSettings): void }): React.JSX.Element {
  const config = value ?? { providerId: '', model: '' }
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [notice, setNotice] = useState('')
  const ownUtterance = useRef<SpeechSynthesisUtterance>()
  const alive = useRef(true)
  const stopPreview = (): void => { if (ownUtterance.current) { window.speechSynthesis?.cancel(); ownUtterance.current = undefined } }
  useEffect(() => {
    alive.current = true
    const speech = window.speechSynthesis
    if (!speech) return
    const refresh = (): void => setVoices(speech.getVoices().filter(voice => voice.localService))
    refresh(); speech.addEventListener('voiceschanged', refresh)
    return () => { alive.current = false; speech.removeEventListener('voiceschanged', refresh); stopPreview() }
  }, [])
  const preview = (): void => {
    const speech = window.speechSynthesis
    if (!speech || speech.speaking) { setNotice(zh ? '另一个语音正在播报，请先结束。' : 'Speech is already playing. End it first.'); return }
    const selected = selectLocalSpeechVoice(voices, config, zh ? 'zh' : 'en')
    if (!selected.voice) { setNotice(zh ? '没有本地系统声音，请安装系统语音包。' : 'No local voice is available. Install a system voice.'); return }
    const utterance = new SpeechSynthesisUtterance(zh ? '这是 EastGenesis 的本地语音试听。' : 'This is a local EastGenesis voice preview.')
    utterance.voice = selected.voice; utterance.lang = selected.voice.lang; utterance.rate = selected.rate
    ownUtterance.current = utterance
    utterance.onend = () => { if (ownUtterance.current === utterance) ownUtterance.current = undefined }
    utterance.onerror = () => { if (ownUtterance.current === utterance) ownUtterance.current = undefined; if (alive.current) setNotice(zh ? '试听未完成，请重试或选择其他声线。' : 'Preview failed. Try another voice.') }
    setNotice(selected.fallback ? (zh ? '原声线不可用，试听使用本地备选声音。' : 'Selected voice unavailable; preview uses a local fallback.') : '')
    speech.speak(utterance)
  }
  return <><h2 className="desktop-preference-heading">{zh ? '本地语音播报' : 'Local speech playback'}</h2><div className="desktop-preference-card">
    <PreferenceRow title={zh ? '声线' : 'Voice'} description={zh ? '只使用本机系统声音，试听不会调用模型。' : 'Only local system voices. Preview makes no model request.'}>
      <select className="select" aria-label={zh ? '本地声线' : 'Local voice'} value={config.localVoiceUri ?? ''} onChange={event => onChange({ ...config, localVoiceUri: event.target.value || undefined })}><option value="">{zh ? '按界面语言自动选择' : 'Match app language'}</option>{config.localVoiceUri && !voices.some(voice => voice.voiceURI === config.localVoiceUri) && <option value={config.localVoiceUri}>{zh ? '原声线当前不可用' : 'Selected voice unavailable'}</option>}{voices.map(voice => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}</option>)}</select>
    </PreferenceRow><PreferenceRow title={zh ? '语速' : 'Speech rate'}><input type="range" aria-label={zh ? '语速' : 'Speech rate'} min={0.5} max={2} step={0.1} value={config.speechRate ?? 1} onChange={event => onChange({ ...config, speechRate: Number(event.target.value) })} /><span>{(config.speechRate ?? 1).toFixed(1)}×</span></PreferenceRow>
    <PreferenceRow title={zh ? '试听当前选择' : 'Preview selection'}><button className="btn btn-ghost" onClick={preview}>{zh ? '试听' : 'Preview'}</button><button className="btn btn-ghost" onClick={stopPreview}>{zh ? '停止试听' : 'Stop preview'}</button></PreferenceRow>
  </div>{notice && <p className="settings-hint" role="status">{notice}</p>}</>
}
