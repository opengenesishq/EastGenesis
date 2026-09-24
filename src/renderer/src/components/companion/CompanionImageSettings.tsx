import { useEffect, useRef, useState } from 'react'
import type { CompanionImageAsset } from '../../../../shared/companion-appearance-types'
import { normalizeDesktopCompanionSettings } from '../../../../shared/desktop-companion-settings'
import { useStore } from '../../store'
import './companion-images.css'

export default function CompanionImageSettings(): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const imageId = useStore(state => state.settings.desktopCompanion?.imageId)
  const [images, setImages] = useState<CompanionImageAsset[]>([])
  const [preview, setPreview] = useState<{ dataUrl: string; name: string }>()
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const alive = useRef(true), version = useRef(0)
  const tr = (cn: string, en: string): string => zh ? cn : en
  const refresh = async (): Promise<void> => {
    const next = await window.agentDesk.listCompanionImages()
    if (alive.current) setImages(next)
  }
  useEffect(() => { alive.current = true; void refresh().catch(cause=>setError(String(cause))); return () => { alive.current = false; version.current++ } }, [])
  useEffect(() => {
    const current = ++version.current; setPreview(undefined)
    if (!imageId) return
    void window.agentDesk.previewCompanionImage(imageId).then(result => { if (alive.current && version.current === current) setPreview({dataUrl:result.dataUrl,name:result.asset.name}) })
      .catch(cause => { if (alive.current && version.current === current) setError(String(cause)) })
  }, [imageId])
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true); setError('')
    try { await action(); await refresh() } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  const select = async (id?: string): Promise<void> => {
    if (id) await window.agentDesk.previewCompanionImage(id)
    await useStore.getState().updateSettings({ desktopCompanion: { ...normalizeDesktopCompanionSettings(useStore.getState().settings.desktopCompanion), imageId: id } })
  }
  return <section className="companion-images" data-companion-images>
    <h4>{tr('随侍形象', 'Companion appearance')}</h4>
    <select className="select select-block" aria-label={tr('随侍形象', 'Companion appearance')} disabled={busy} value={imageId ?? ''} onChange={event => void run(()=>select(event.target.value || undefined))}>
      <option value="">{tr('内置明代随侍（3D）', 'Built-in Ming attendant (3D)')}</option>
      {imageId && !images.some(image=>image.id===imageId) && <option value={imageId}>{tr('图片不可用，请重新选择', 'Image unavailable; choose another')}</option>}
      {images.map(image=><option key={image.id} value={image.id}>{image.name}</option>)}
    </select>
    <p className="settings-hint">{tr('可以导入透明 PNG 或动态 GIF。形象保存在本机，选择后立即生效；内置 3D 随侍保留为默认。', 'Import a transparent PNG or animated GIF. Images stay on this computer and selection applies immediately. The built-in 3D attendant remains the default.')}</p>
    {preview && <div className="companion-image-preview"><img src={preview.dataUrl} alt={preview.name} draggable={false} /></div>}
    <button className="btn btn-secondary" type="button" disabled={busy} onClick={()=>void run(async()=>{const image=await window.agentDesk.importCompanionImage();if(image)await select(image.id)})}>{tr('导入 PNG / GIF', 'Import PNG / GIF')}</button>
    <p className="settings-hint">{tr('每张最多 8 MB、800 万像素。移除只删除应用保存的副本。', 'Up to 8 MB and 8 million pixels per image. Removal deletes only the app’s copy.')}</p>
    {images.map(image=><div className="companion-image-row" key={image.id}><span title={image.name}>{image.name}<small>{image.width} × {image.height} · {Math.ceil(image.bytes/1024)} KB</small></span>
      <button className="btn btn-ghost btn-sm" type="button" disabled={busy||image.id===imageId} onClick={()=>void run(()=>window.agentDesk.removeCompanionImage(image.id))}>{image.id===imageId ? tr('使用中', 'Selected') : tr('移除副本', 'Remove copy')}</button></div>)}
    {error && <p role="alert" className="notice notice-error">{error}</p>}
  </section>
}
