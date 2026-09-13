const http = require('node:http'), https = require('node:https')
const net = require('node:net'), tls = require('node:tls')

function blockNetwork() {
  const attempts = [], originals = []
  function block(target, method, name) {
    const original = target[method]
    originals.push(() => { target[method] = original })
    target[method] = () => { attempts.push(name); throw new Error(`Unexpected network request: ${name}`) }
  }
  for (const [target, methods, name] of [[http, ['request', 'get'], 'http'], [https, ['request', 'get'], 'https'],
    [net, ['connect', 'createConnection'], 'net'], [tls, ['connect'], 'tls'], [globalThis, ['fetch'], 'fetch']]) {
    for (const method of methods) block(target, method, `${name}.${method}`)
  }
  return { attempts, restore() { for (const restore of originals.reverse()) restore() } }
}
module.exports = { blockNetwork }
