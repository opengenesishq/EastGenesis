const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const dns = require('node:dns')
const child = require('node:child_process')
const assert = require('node:assert/strict')

module.exports = function makeGuard() {
  const phases = []
  function guard(name, run) {
    const calls = { name, fileReads: 0, fileWrites: 0, network: 0, childProcesses: 0 }
    const restore = []
    const patch = (object, names, category) => {
      for (const key of names) {
        if (typeof object[key] !== 'function') continue
        const original = object[key]
        object[key] = () => { calls[category]++; throw new Error(`Unexpected ${category}: ${key}`) }
        restore.push(() => { object[key] = original })
      }
    }
    patch(fs, ['readFileSync', 'readFile', 'readdirSync', 'readdir', 'statSync', 'stat', 'accessSync', 'access', 'existsSync', 'openSync', 'open', 'createReadStream'], 'fileReads')
    patch(fs, ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'mkdirSync', 'mkdir', 'renameSync', 'rename', 'unlinkSync', 'unlink', 'rmSync', 'rm', 'writeSync', 'write', 'createWriteStream', 'fsyncSync'], 'fileWrites')
    patch(fsPromises, ['readFile', 'readdir', 'stat', 'access', 'open'], 'fileReads')
    patch(fsPromises, ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm'], 'fileWrites')
    patch(http, ['request', 'get', 'createServer'], 'network'); patch(https, ['request', 'get', 'createServer'], 'network')
    patch(net, ['connect', 'createConnection', 'createServer'], 'network'); patch(tls, ['connect', 'createServer'], 'network')
    patch(dns, ['lookup', 'resolve', 'resolve4', 'resolve6'], 'network')
    patch(child, ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'], 'childProcesses')
    const fetch = global.fetch
    global.fetch = () => { calls.network++; throw new Error('Unexpected network: fetch') }
    restore.push(() => { global.fetch = fetch })
    let result
    try { result = run() }
    finally { restore.reverse().forEach((fn) => fn()); phases.push(calls) }
    assert.equal(calls.fileReads + calls.fileWrites + calls.network + calls.childProcesses, 0, JSON.stringify(calls))
    return result
  }
  return { guard, phases }
}
