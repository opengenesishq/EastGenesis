import { spawn } from 'node:child_process'

export async function runFifoDescriptorProbe(reconcilerUrl, fileRoot) {
  const readyMarker = 'fifo-probe-ready\n'
  const source = descriptorProbeSource(reconcilerUrl, fileRoot, readyMarker)
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  let ready = false
  let settled = false
  let actionTimer

  await new Promise((resolve, reject) => {
    const startupTimer = setTimeout(() => fail('effect reconciler cold import exceeded 15000ms'), 15_000)
    const cleanup = () => {
      clearTimeout(startupTimer)
      if (actionTimer) clearTimeout(actionTimer)
    }
    const fail = (reason) => {
      if (settled) return
      settled = true
      cleanup()
      child.kill('SIGKILL')
      reject(new Error(`${reason}: ${JSON.stringify({ stdout, stderr })}`))
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      if (ready || !stdout.includes(readyMarker)) return
      ready = true
      clearTimeout(startupTimer)
      actionTimer = setTimeout(
        () => fail('write_file FIFO descriptor probe exceeded 2000ms after module import'),
        2_000
      )
    })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => fail(`FIFO descriptor child failed to start: ${error.message}`))
    child.on('close', (code, signal) => {
      if (settled) return
      cleanup()
      if (!ready) return fail(`effect reconciler child exited before ready (code=${code}, signal=${signal})`)
      if (code !== 0 || signal) return fail(`FIFO descriptor child failed (code=${code}, signal=${signal})`)
      settled = true
      resolve()
    })
  })
}

function descriptorProbeSource(reconcilerUrl, fileRoot, readyMarker) {
  return `
    const reconciler = await import(${JSON.stringify(reconcilerUrl)});
    process.stdout.write(${JSON.stringify(readyMarker)});
    try {
      await reconciler.buildEffectDescriptor({
        toolName: 'write_file',
        toolInput: { path: 'planner-fifo', content: 'replacement' },
        cwd: ${JSON.stringify(fileRoot)}
      });
      process.exitCode = 2;
    } catch (error) {
      if (!String(error?.message ?? error).includes('不是普通文件')) process.exitCode = 3;
    }
  `
}
