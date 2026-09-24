import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { RemoteConnectionForm } from './RemoteConnectionForm'
import { RemoteContinuationPanel } from '../studio/RemoteContinuationPanel'
import '../studio/remote-continuation.css'

export default function RemoteConnectionSettings(): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const projects = useStore(state => state.projectWorkspaces)
  const [projectId, setProjectId] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => { void useStore.getState().refreshProjectWorkspaces().catch(() => undefined) }, [])
  const active = projects.filter(project => project.status === 'active')
  const selected = active.some(project => project.id === projectId) ? projectId : active[0]?.id
  return <>
    <RemoteConnectionForm onApplied={() => setRevision(value => value + 1)} />
    <label className="field-label">{zh ? '手机可操作的项目' : 'Project for this phone'}<select className="select select-block" value={selected ?? ''} onChange={event => setProjectId(event.target.value)}><option value="">{zh ? '选择项目' : 'Choose project'}</option>{active.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
    <RemoteContinuationPanel key={`${selected ?? ''}:${revision}`} projectId={selected} active showConnectionSettings={false} />
  </>
}
