import { Film, LoaderCircle, Plus } from 'lucide-react'
import { videoStudioText } from '../../i18n/studioTranslations'
import { useStore } from '../../store'

interface Props {
  name: string
  script: string
  creating: boolean
  onNameChange: (value: string) => void
  onScriptChange: (value: string) => void
  onSubmit: (draft: { name: string; script: string }) => void
}

export default function VideoQuickStart(props: Props): React.JSX.Element {
  const language = useStore((state) => state.settings.language)
  const text = videoStudioText(language)
  return <div className="video-studio-shell-empty">
    <Film size={24} aria-hidden="true" />
    <h2>{text.quickStartTitle}</h2>
    <p>{text.quickStartDescription}</p>
    <form data-video-quick-start onSubmit={(event) => {
      event.preventDefault()
      const values = new FormData(event.currentTarget)
      props.onSubmit({ name: String(values.get('videoTitle') ?? ''), script: String(values.get('videoScript') ?? '') })
    }}>
      <input className="input" name="videoTitle" value={props.name}
        onChange={(event) => props.onNameChange(event.target.value)} placeholder={text.titlePlaceholder}
        aria-label={text.titleLabel} maxLength={120} autoFocus />
      <textarea className="input" name="videoScript" value={props.script}
        onChange={(event) => props.onScriptChange(event.target.value)} placeholder={text.scriptPlaceholder}
        aria-label={text.scriptLabel} rows={4} maxLength={20_000} />
      <button type="submit" className="btn btn-primary btn-sm"
        disabled={props.creating || !props.name.trim() || !props.script.trim()}>
        {props.creating ? <LoaderCircle className="video-studio-shell-spinner" size={14} /> : <Plus size={14} />}
        {props.creating ? text.creating : text.start}
      </button>
    </form>
  </div>
}
