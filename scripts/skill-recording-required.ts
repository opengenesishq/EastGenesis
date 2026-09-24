import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillRecordingService } from '../src/main/skill-recording/recording'
import { saveRecordedSkill } from '../src/main/skill-recording/storage'
import { readPluginRegistryState, scanPluginRegistry } from '../src/main/pluginRegistry'
import { parseSkillMarkdown } from '../src/main/skill/skill-loader'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=', 'base64')
const source = { id: 'window:10:0', name: 'PRIVATE_WINDOW_NAME', kind: 'window' as const }
const begin = { name: 'export-weekly-report', description: '导出本周工作报告，在每周整理报告时使用。', consent: true, allowScreenshots: false }
let checks = 0
async function check(name: string, action: () => unknown | Promise<unknown>): Promise<void> { await action(); checks++; console.log(`PASS ${name}`) }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'caogen-recorded-skill-')), state = join(home, 'app', 'plugin-registry-state.json')
  let captures = 0, listings = 0, captureError = false, captureWait: Promise<void> | undefined
  const service = new SkillRecordingService({
    sources: async () => { listings++; return [source] },
    capture: async () => { captures++; if (captureWait) await captureWait; if (captureError) throw new Error('screen permission denied'); return { bytes: png, previewDataUrl: `data:image/png;base64,${png.toString('base64')}`, width: 1, height: 1 } },
    save: (name, markdown, images) => saveRecordedSkill(home, state, name, markdown, images)
  })
  try {
    await check('explicit start and image opt-in; no collection or files before consent', async () => {
      assert.throws(() => service.begin(1, { ...begin, consent: false }), /范围/)
      const view = service.begin(1, begin)
      assert.equal(captures, 0); assert.equal(listings, 0); assert.equal(existsSync(join(home, '.caogen')), false)
      await assert.rejects(service.sources(1, view.id), /未允许/)
      const step = service.add(1, view.id, { action: '打开报表页', outcome: '看到本周报表' })
      await assert.rejects(service.capture(1, view.id, step.steps[0].id, source), /未允许/)
      assert.equal(captures, 0); service.cancel(1, view.id)
    })
    await check('manual steps and chosen images become an editable draft; names/paths are not inserted', async () => {
      const view = service.begin(1, { ...begin, allowScreenshots: true })
      await service.sources(1, view.id); assert.equal(listings, 1); assert.equal(captures, 0)
      const step = service.add(1, view.id, { action: '选择本周，然后点击导出。', outcome: '下载文件只包含本周条目。' })
      const captured = await service.capture(1, view.id, step.steps[0].id, source)
      assert.equal(captured.steps[0].image?.width, 1)
      const stopped = service.stop(1, view.id)
      assert.match(stopped.markdown!, /assets\/step-1\.png/)
      assert.doesNotMatch(stopped.markdown!, /PRIVATE_WINDOW_NAME|window:10:0|caogen-recorded-skill-/)
      assert.throws(() => service.add(1, view.id, { action: 'Late action', outcome: 'Late result' }), /停止/)
      await assert.rejects(service.capture(1, view.id, step.steps[0].id, source), /停止/)
      const markdown = stopped.markdown!.replace('下载文件只包含本周条目。', '下载文件只包含本周条目，并核对行数。')
      assert.throws(() => service.save(1, view.id, markdown, false), /检查/)
      const saved = service.save(1, view.id, markdown, true)
      assert.equal(saved.enabled, true); assert.equal(saved.imageCount, 1)
      assert.equal(readFileSync(saved.path, 'utf8'), markdown)
      assert.deepEqual(readFileSync(join(home, '.caogen', 'skills', begin.name, 'assets', 'step-1.png')), png)
      const parsed = parseSkillMarkdown(saved.path, markdown, 'global')
      assert.equal(parsed.steps.length, 1); assert.equal(parsed.verification.length, 1)
      const registry = scanPluginRegistry([join(home, '.caogen')], {}, readPluginRegistryState(state))
      const item = registry.items.find(item => item.name === begin.name)!
      assert.equal(item.enabled, true); assert.equal(item.trust.status, 'approved')
      if (process.platform !== 'win32') assert.equal(statSync(saved.path).mode & 0o777, 0o600)
    })
    await check('permission denial leaves text recording usable and saved skill has no images', async () => {
      const view = service.begin(2, { ...begin, name: 'text-only-report', allowScreenshots: true })
      const added = service.add(2, view.id, { action: '打开统计页面。', outcome: '显示当前统计周期。' })
      captureError = true
      await assert.rejects(service.capture(2, view.id, added.steps[0].id, source), /permission denied/)
      captureError = false
      const stopped = service.stop(2, view.id), saved = service.save(2, view.id, stopped.markdown!, true)
      assert.equal(saved.imageCount, 0); assert.equal(saved.enabled, true)
      assert.equal(existsSync(join(home, '.caogen', 'skills', 'text-only-report', 'assets')), false)
    })
    await check('cancel/window loss/stop invalidate late screenshots and discard unsaved state', async () => {
      for (const mode of ['cancel', 'close', 'stop'] as const) {
        const view = service.begin(3, { ...begin, name: `discard-${mode}`, allowScreenshots: true })
        const added = service.add(3, view.id, { action: '演示动作', outcome: '观察结果' })
        const gate = deferred(); captureWait = gate.promise
        const pending = service.capture(3, view.id, added.steps[0].id, source)
        const rejected = assert.rejects(pending, /不存在|停止/)
        if (mode === 'cancel') service.cancel(3, view.id)
        else if (mode === 'close') service.clearOwner(3)
        else service.stop(3, view.id)
        gate.resolve(); await rejected; captureWait = undefined
        assert.equal(existsSync(join(home, '.caogen', 'skills', `discard-${mode}`)), false)
        service.clearOwner(3)
      }
    })
    await check('cross-window calls, unreviewed credentials, extra fields, and overwrite are blocked', async () => {
      assert.throws(() => service.begin(4, { ...begin, monitorKeyboard: true }), /参数/)
      const view = service.begin(4, begin)
      assert.throws(() => service.add(9, view.id, { action: 'x', outcome: 'y' }), /当前窗口/)
      const step = service.add(4, view.id, { action: 'api_key=DO_NOT_KEEP_THIS_VALUE', outcome: '检查完成' })
      assert.doesNotMatch(step.steps[0].action, /DO_NOT_KEEP/)
      const stopped = service.stop(4, view.id)
      assert.throws(() => service.save(4, view.id, `${stopped.markdown}\nBearer ABCDEFGHIJKLMNO`, true), /凭据/)
      const old = readFileSync(join(home, '.caogen', 'skills', begin.name, 'SKILL.md'), 'utf8')
      assert.throws(() => service.save(4, view.id, stopped.markdown!, true), /同名/)
      assert.equal(readFileSync(join(home, '.caogen', 'skills', begin.name, 'SKILL.md'), 'utf8'), old)
      service.cancel(4, view.id)
    })
    await check('controlled save rejects symlink skill roots and invalid edited Markdown', () => {
      const alternate = join(home, 'alternate'); mkdirSync(alternate)
      const outside = join(home, 'outside'); mkdirSync(outside)
      symlinkSync(outside, join(alternate, '.caogen'))
      const view = service.begin(5, { ...begin, name: 'safe-path' })
      service.add(5, view.id, { action: '查看报告', outcome: '内容正确' })
      const stopped = service.stop(5, view.id)
      assert.throws(() => saveRecordedSkill(alternate, state, 'safe-path', stopped.markdown!, []), /符号链接/)
      assert.throws(() => saveRecordedSkill(home, state, 'safe-path', '# no metadata', []), /元数据/)
      assert.equal(existsSync(join(outside, 'skills')), false)
      service.cancel(5, view.id)
    })
    await check('temporary recording is labeled and saves only inside its temporary profile', () => {
      const profile = join(home, 'temporary-profile'); mkdirSync(profile)
      const temporary = new SkillRecordingService({ temporary: () => true, sources: async () => [], capture: async () => { throw new Error('not requested') },
        save: (name, markdown, images) => saveRecordedSkill(profile, join(profile, 'plugin-registry-state.json'), name, markdown, images) })
      const view = temporary.begin(6, { ...begin, name: 'temporary-example' })
      assert.equal(view.temporary, true)
      temporary.add(6, view.id, { action: '查看示例', outcome: '显示示例内容' })
      const stopped = temporary.stop(6, view.id), saved = temporary.save(6, view.id, stopped.markdown!, true)
      assert.equal(saved.enabled, true)
      assert.equal(saved.path, join(profile, '.caogen', 'skills', 'temporary-example', 'SKILL.md'))
      assert.equal(existsSync(join(home, '.caogen', 'skills', 'temporary-example')), false)
    })
    console.log(`RESULT ${checks}/${checks}; synthetic in-memory PNGs and temporary skill roots only; no real screen, provider, network, or user-data reads.`)
  } finally { rmSync(home, { recursive: true, force: true }) }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
