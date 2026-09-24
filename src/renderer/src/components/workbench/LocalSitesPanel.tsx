import { useStore } from '../../store'
import LocalSitePreviewControls from './LocalSitePreviewControls'
import './local-sites.css'

export default function LocalSitesPanel(): React.JSX.Element {
  const id = useStore(s => s.activeId)
  const zh = useStore(s => s.settings.language === 'zh')
  if (!id) return <p>{zh ? '选择一个任务后预览网站。' : 'Select a task to preview its website.'}</p>
  return <section className="site-deployment-panel" data-local-sites={id}>
    <LocalSitePreviewControls key={id} sessionId={id} zh={zh} />
  </section>
}
