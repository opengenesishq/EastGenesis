import { MING_SCENE_REFERENCE, mingHistoricalRoleById, mingHistoricalSourcesFor } from './kit/palace/mingHistoricalMapping'
import './ming-historical-context.css'

export function MingHistoricalContext({ zh, roleId }: { zh: boolean; roleId?: string }) {
  const role = roleId ? mingHistoricalRoleById(roleId) : undefined
  if (roleId && !role) return null
  const sources = mingHistoricalSourcesFor(roleId)
  return <details className={`ming-history ${roleId ? 'ming-history-role' : 'ming-history-scene'}`} data-ming-history={roleId ?? 'scene'}>
    <summary>{zh ? (roleId ? '明代职掌与功能映射' : '明代场景参考') : (roleId ? 'Historical role and mapping' : 'Ming scene reference')}</summary>
    <div className="ming-history-content">
      {role ? <>
        <p><strong>{zh ? '明代职掌：' : 'Historical role: '}</strong>{zh ? role.historicalDuty : role.historicalDutyEn}</p>
        <p><strong>{zh ? 'EastGenesis 功能：' : 'In EastGenesis: '}</strong>{zh ? role.productMapping : role.productMappingEn}</p>
        {role.note && <p>{zh ? role.note : role.noteEn}</p>}
      </> : <>
        <p><strong>{zh ? MING_SCENE_REFERENCE.period : MING_SCENE_REFERENCE.periodEn}</strong></p>
        <p>{zh ? MING_SCENE_REFERENCE.description : MING_SCENE_REFERENCE.descriptionEn}</p>
        <p>{zh ? MING_SCENE_REFERENCE.layout : MING_SCENE_REFERENCE.layoutEn}</p>
        <p>{zh ? MING_SCENE_REFERENCE.attire : MING_SCENE_REFERENCE.attireEn}</p>
        <p>{zh ? MING_SCENE_REFERENCE.assets : MING_SCENE_REFERENCE.assetsEn}</p>
      </>}
      <details className="ming-history-sources">
        <summary>{zh ? '资料来源' : 'Sources'}</summary>
        <ul>{sources.map(source => <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{zh ? source.title : source.titleEn}</a></li>)}</ul>
      </details>
    </div>
  </details>
}
