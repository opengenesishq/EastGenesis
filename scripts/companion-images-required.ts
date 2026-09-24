import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CompanionImageStore } from '../src/main/companion-images'
import { normalizeDesktopCompanionSettings } from '../src/shared/desktop-companion-settings'
async function main(): Promise<void> {
const root=mkdtempSync(join(tmpdir(),'caogen-companion-images-'))
try {
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')
  const source=join(root,'source.png');writeFileSync(source,image)
  const store=new CompanionImageStore(root), asset=await store.import(source,()=>true)
  assert.equal((await store.import(source,()=>true)).id,asset.id)
  assert.equal(store.list().length,1)
  assert.equal(new CompanionImageStore(root).preview(asset.id).dataUrl,`data:image/png;base64,${image.toString('base64')}`)
  assert.equal(normalizeDesktopCompanionSettings({imageId:asset.id}).imageId,asset.id)
  assert.equal(normalizeDesktopCompanionSettings({imageId:'../../file'}).imageId,undefined)
  store.remove(asset.id);assert.deepEqual(readFileSync(source),image);assert.equal(store.list().length,0)
  console.log('PASS: managed image persists, deduplicates and removes only the imported copy')
  const bad=join(root,'script.png');writeFileSync(bad,'<svg onload="alert(1)"></svg>');await assert.rejects(()=>store.import(bad,()=>true))
  await assert.rejects(()=>store.import(source,()=>false))
  const large=Buffer.from(image);large.writeUInt32BE(100000,16);writeFileSync(bad,large);await assert.rejects(()=>store.import(bad,()=>true))
  const link=join(root,'link.png');symlinkSync(source,link);await assert.rejects(()=>store.import(link,()=>true))
  const restored=await store.import(source,()=>true);const changed=Buffer.from(image);changed[35]^=255;writeFileSync(join(root,'companion-images',`${restored.id}.image`),changed);assert.throws(()=>store.preview(restored.id))
  console.log('PASS: unsupported content, oversized dimensions, symlink, decode failure and changed bytes are rejected')
} finally {rmSync(root,{recursive:true,force:true})}

}
void main().catch(error=>{console.error(error);process.exitCode=1})
