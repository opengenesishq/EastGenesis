import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { closeSync, fstatSync, lstatSync, openSync, readlinkSync, readSync } from 'node:fs'
import path from 'node:path'

const MAX_GIT_OUTPUT = 512 * 1024 * 1024
const FILE_HASH_BUFFER_BYTES = 1024 * 1024

export function assertGitSourceOutputRoot(repoRoot, outRoot) {
  const root = path.resolve(repoRoot)
  const output = path.resolve(outRoot)
  const relative = path.relative(root, output)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return
  if (!relative) throw new Error('Deep output root must not be the repository root')
  const probe = path.join(relative, '.caogen-deep-output-probe').split(path.sep).join('/')
  try {
    execFileSync('git', ['check-ignore', '--no-index', '-q', '--', probe], {
      cwd: root,
      stdio: 'ignore'
    })
  } catch (error) {
    if (error && typeof error === 'object' && error.status === 1) {
      throw new Error(`Deep output root inside the repository must be ignored by Git: ${output}`)
    }
    throw new Error(`Unable to verify Deep output root ignore policy: ${output}`)
  }
}

export function readGitSourceState(repoRoot) {
  const status = gitBuffer(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const trackedDiff = gitBuffer(repoRoot, [
    'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--submodule=short', 'HEAD', '--'
  ])
  const index = gitBuffer(repoRoot, ['ls-files', '--stage', '-z'])
  const untrackedPaths = gitBuffer(repoRoot, ['ls-files', '-z', '--others', '--exclude-standard'])
  const untracked = hashUntrackedFiles(repoRoot, untrackedPaths.value)
  const complete = status.ok && trackedDiff.ok && index.ok && untrackedPaths.ok && untracked.complete
  const statusDigest = digest(status.value)
  const trackedDiffDigest = digest(trackedDiff.value)
  const indexDigest = digest(index.value)
  const untrackedDigest = untracked.digest
  return {
    complete,
    worktreeClean: status.value.length === 0,
    statusEntryCount: countPorcelainEntries(status.value),
    statusDigest,
    trackedDiffDigest,
    indexDigest,
    untrackedDigest,
    sourceDigest: complete
      ? digest(Buffer.from(`${statusDigest}\n${trackedDiffDigest}\n${indexDigest}\n${untrackedDigest}\n`, 'utf8'))
      : null
  }
}

function hashUntrackedFiles(repoRoot, list) {
  const hash = createHash('sha256')
  let complete = true
  for (const pathBytes of splitNull(list).sort(Buffer.compare)) {
    frame(hash, pathBytes)
    try {
      const relativePath = decodeGitPath(pathBytes)
      const filePath = resolveGitPath(repoRoot, relativePath)
      const stat = lstatSync(filePath)
      frame(hash, Buffer.from(String(stat.mode), 'utf8'))
      if (stat.isSymbolicLink()) {
        frame(hash, Buffer.from('symlink', 'utf8'))
        frame(hash, readlinkSync(filePath, { encoding: 'buffer' }))
      } else if (stat.isFile()) {
        frame(hash, Buffer.from('file', 'utf8'))
        frame(hash, hashFile(filePath))
      } else {
        throw new Error(`unsupported source entry type: ${relativePath}`)
      }
    } catch (error) {
      complete = false
      frame(hash, Buffer.from(`error:${error instanceof Error ? error.message : String(error)}`, 'utf8'))
    }
  }
  return { complete, digest: hash.digest('hex') }
}

function decodeGitPath(pathBytes) {
  const relativePath = pathBytes.toString('utf8')
  if (!Buffer.from(relativePath, 'utf8').equals(pathBytes)) {
    throw new Error('Git source path is not valid UTF-8')
  }
  return relativePath
}

function resolveGitPath(repoRoot, relativePath) {
  if (path.posix.isAbsolute(relativePath)) throw new Error('Git source path must be relative')
  const resolved = path.resolve(repoRoot, ...relativePath.split('/'))
  const relative = path.relative(path.resolve(repoRoot), resolved)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Git source path escaped the repository')
  }
  return resolved
}

function hashFile(filePath) {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(FILE_HASH_BUFFER_BYTES)
  const descriptor = openSync(filePath, 'r')
  try {
    const before = fstatSync(descriptor, { bigint: true })
    let bytesRead = 0
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = fstatSync(descriptor, { bigint: true })
    if (!sameFileState(before, after)) throw new Error('source file changed while hashing')
    return hash.digest()
  } finally {
    closeSync(descriptor)
  }
}

function sameFileState(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function gitBuffer(repoRoot, args) {
  try {
    return {
      ok: true,
      value: execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'buffer',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: MAX_GIT_OUTPUT
      })
    }
  } catch (error) {
    return {
      ok: false,
      value: Buffer.from(error instanceof Error ? error.message : String(error), 'utf8')
    }
  }
}

function countPorcelainEntries(value) {
  const fields = splitNull(value)
  let count = 0
  for (let index = 0; index < fields.length; index += 1) {
    count += 1
    const status = fields[index].subarray(0, 2).toString('utf8')
    if (status.includes('R') || status.includes('C')) index += 1
  }
  return count
}

function splitNull(value) {
  const fields = []
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) continue
    if (index > start) fields.push(value.subarray(start, index))
    start = index + 1
  }
  if (start < value.length) fields.push(value.subarray(start))
  return fields
}

function frame(hash, value) {
  hash.update(String(value.length)).update(':').update(value).update('\n')
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}
