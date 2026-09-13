import assert from 'node:assert/strict'

/** The mock model derives file contents from the actual user HTTP payload; it never invents missing source material. */
export function officeGoldenSteps(content, expectedCsv) {
  const csv = content.match(/\[SOURCE_CSV\]\n([\s\S]*?)\[\/SOURCE_CSV\]/)?.[1]
  assert.equal(csv, expectedCsv, 'Actual model request is missing or has changed the user-supplied CSV; refusing to generate any source snapshot')
  const [header, ...records] = csv.trimEnd().split('\n').map((row) => row.split(','))
  assert.deepEqual(header, ['品名', '数量', '单价'])
  const items = records.map(([name, quantity, price]) => {
    assert(name && Number.isFinite(Number(quantity)) && Number.isFinite(Number(price)), 'Invalid actual source row')
    return { name, quantity: Number(quantity), price: Number(price) }
  })
  const total = items.reduce((sum, item) => sum + item.quantity * item.price, 0)
  const paragraph = `采购建议：按资料采购 ${items.map((item) => `${item.name} ${item.quantity} 件`).join('和 ')}，金额合计 ${total}。`
  const rows = [['品名', '数量', '单价', '金额'], ...items.map((item) => [item.name, item.quantity, item.price, item.quantity * item.price]), ['合计', '', '', total]]
  return [
    { tool: 'write_file', id: 'office-source-snapshot', input: { path: 'sources/input.csv', content: csv } },
    { tool: 'create_document', id: 'office-document-initial', input: { path: 'deliverables/procurement.docx', title: '采购说明', paragraphs: ['来源：本任务用户粘贴的 CSV，快照保存在 sources/input.csv。', paragraph, '保持段落：所有金额均为测试资料单位，不代表真实交易。'], source_refs: ['sources/input.csv'] } },
    { tool: 'create_spreadsheet', id: 'office-spreadsheet-initial', input: { path: 'deliverables/procurement.xlsx', title: '采购明细', sheets: [{ name: 'Data', rows }], source_refs: ['sources/input.csv'] } }
  ]
}

export function failedOfficeTool(tools) {
  for (const tool of tools) {
    const output = String(tool.content)
    if (/失败|已阻止|拒绝|\b(?:error|corruption)\b/i.test(output)) return output
    if (tool.tool_call_id === 'office-source-snapshot' && !output.includes('已写入 sources/input.csv')) return output
    if (['office-document-initial', 'office-spreadsheet-initial'].includes(tool.tool_call_id) && !validGeneratedOffice(output)) return output
    if (tool.tool_call_id?.startsWith('office-revision-') && !registeredRevision(output)) return output
  }
  return undefined
}

function validGeneratedOffice(output) {
  try { const result = JSON.parse(output); return ['document', 'spreadsheet'].includes(result.artifactKind) && typeof result.path === 'string' && typeof result.sha256 === 'string' && result.bytes > 0 } catch { return false }
}

function registeredRevision(output) {
  try { const result = JSON.parse(output); return result.status === 'registered' && typeof result.artifactId === 'string' && result.version > 1 } catch { return false }
}
