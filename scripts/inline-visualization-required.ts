import assert from 'node:assert/strict'
import { compileVizExpression, parseInlineVisualization, evaluateVisualization } from '../src/shared/inline-visualization'
const spec = parseInlineVisualization(JSON.stringify({ version: 1, kind: 'chart', title: '离线参数示例', variables: [{ id: 'rate', label: '增长率', min: 0, max: 1, step: .01, value: .1 }], metrics: [{ label: '五年金额', expression: '100 * (1 + rate)^5' }], series: [{ label: '复利', expression: '100 * pow(1 + rate,x)', min: 0, max: 5, samples: 6 }] }))
assert.ok(Math.abs(evaluateVisualization(spec,{rate:.1}).series[0].points[5].y - 161.051) < 1e-7)
assert.ok(evaluateVisualization(spec,{rate:.2}).metrics[0].value > evaluateVisualization(spec,{rate:.1}).metrics[0].value)
assert.equal(compileVizExpression('2^3^2')({}), 512)
assert.equal(compileVizExpression('-2^2 + max(3,4)')({}),0)
for (const source of ['window.agentDesk.deleteHistory(1)', 'fetch(1)', 'constructor(1)', '__proto__.x', '1;2','x=3','sqrt(1,2)']) assert.throws(() => compileVizExpression(source)({}))
assert.throws(() => compileVizExpression('1/0')({}))
assert.throws(() => compileVizExpression('secret')({}))
assert.throws(() => compileVizExpression('('.repeat(34)+'1'+')'.repeat(34)))
assert.throws(() => parseInlineVisualization(JSON.stringify({version:1,kind:'map',title:'x',markers:[{label:'x',lat:100,lon:0}]})))
assert.throws(() => parseInlineVisualization(JSON.stringify({...spec,series:[{label:'bad',expression:'x',min:0,max:10,samples:1000000}]})))
console.log('PASS: numerical scenarios, live parameter changes, expression grammar, arbitrary-code rejection, nonfinite errors and bounded content')
