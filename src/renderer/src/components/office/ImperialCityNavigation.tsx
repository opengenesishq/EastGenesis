import { IMPERIAL_CITY_ZONES, type ImperialCityNode, type ImperialCityZone } from './kit/palace/imperialCityCatalog'
import './imperial-city.css'

export default function ImperialCityNavigation({ zone, node, nodes, zh, taskTitle, taskAvailable, onZone, onNode, onContinue }: {
  zone: ImperialCityZone; node?: ImperialCityNode; nodes: readonly ImperialCityNode[]; zh: boolean
  taskTitle?: string; taskAvailable: boolean
  onZone(zone: ImperialCityZone): void; onNode(node?: ImperialCityNode): void; onContinue(): void
}): React.JSX.Element {
  return <section className="imperial-city-navigation no-drag" aria-label={zh ? '明代京师场景' : 'Ming capital scenes'}>
    <nav aria-label={zh ? '空间分区' : 'Scene districts'}>{IMPERIAL_CITY_ZONES.map(item => <button key={item.id} type="button"
      className="btn btn-ghost btn-sm" aria-pressed={zone === item.id} data-imperial-zone={item.id} onClick={() => onZone(item.id)}>
      {zh ? item.label : item.labelEn}</button>)}</nav>
    {zone !== 'palace' && <>
      <div className="imperial-city-location">
        {node ? <><button className="btn btn-ghost btn-sm" type="button" data-imperial-back onClick={() => onNode()}>{zh ? '返回分区' : 'District map'}</button>
          <strong>{zh ? node.label : node.labelEn}</strong></> : <span>{zh ? '点击院落进入' : 'Select a courtyard to enter'}</span>}
        <select aria-label={zh ? '进入工作院落' : 'Enter courtyard'} value={node?.id ?? ''} data-imperial-node-select
          onChange={event => onNode(nodes.find(item => item.id === event.target.value))}>
          <option value="">{zh ? '分区总览' : 'District overview'}</option>
          {nodes.map(item => <option key={item.id} value={item.id}>{zh ? item.label : item.labelEn}</option>)}
        </select>
        {node && taskTitle && <button type="button" className="btn btn-primary btn-sm" data-imperial-continue disabled={!taskAvailable} onClick={onContinue}
          title={taskTitle}>{zh ? '继续原任务' : 'Continue original task'} · {taskTitle}</button>}
      </div>
      <small>{zh ? zone === 'offices'
        ? '嘉靖后期（1562—1566）· 官署工作区，具体位置待考；院落与人物为示意，非测绘及真实人员记录。'
        : '嘉靖后期（1562—1566）· 宫城外围的功能节点；示意布局，不表示机构衙署的历史位置。'
        : 'Late Jiajing (1562–1566) · Illustrative work courtyards; not surveyed historical office locations or personnel records.'}</small>
      {!nodes.length && <small>{zh ? '当前机构配置暂无本分区节点，可返回紫禁城查看机构记录。' : 'This institution configuration has no nodes in this district. Return to the Forbidden City to view its records.'}</small>}
      {node && taskTitle && !taskAvailable && <small role="status">{zh ? '原任务已关闭或归属变化，请从任务列表重新选择。' : 'The original task closed or changed ownership. Select it again from the task list.'}</small>}
    </>}
  </section>
}
