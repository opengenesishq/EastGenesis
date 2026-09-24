import { randomUUID } from 'node:crypto'
import type { WslExecutionBinding } from '../../shared/wsl-types'
import { assertWslBinding } from './binding'
import { runWslProbe, wslExecutable } from './discovery'

// One task owns one Linux process group. The lease records /proc start time
// as well as pid; stopping never terminates a distribution or another task.
const INNER = `set -eu
state="$1"; shift
start=$(sed 's/^.*) //' "/proc/$$/stat" | awk '{print $20}')
printf '%s %s\\n' "$$" "$start" > "$state/pid"
exec "$@"`
const OUTER = `set -eu
directory="$1"; token="$2"; inner="$3"; shift 3
cd -- "$directory"
state="/tmp/caogen-wsl-$token"
umask 077
mkdir -- "$state"
cleanup() { rm -f -- "$state/pid"; rmdir -- "$state" 2>/dev/null || true; }
trap cleanup EXIT
/usr/bin/setsid --wait /bin/sh -c "$inner" caogen-group "$state" "$@" &
child=$!
wait "$child"`
const STOP = `set -eu
state="/tmp/caogen-wsl-$1"
[ -d "$state" ] || exit 0
attempt=0
while [ ! -f "$state/pid" ] && [ "$attempt" -lt 20 ]; do sleep 0.05; attempt=$((attempt+1)); done
[ -f "$state/pid" ] || exit 3
read -r pid start < "$state/pid"
case "$pid:$start" in *[!0-9:]*|:*) exit 4;; esac
[ "$pid" -gt 1 ]
[ -r "/proc/$pid/stat" ] || exit 0
current=$(sed 's/^.*) //' "/proc/$pid/stat" | awk '{print $20}')
[ "$current" = "$start" ] || exit 4
/bin/kill -TERM -- "-$pid" 2>/dev/null || true
sleep 0.2
if [ -r "/proc/$pid/stat" ]; then
 current=$(sed 's/^.*) //' "/proc/$pid/stat" | awk '{print $20}')
 [ "$current" != "$start" ] || /bin/kill -KILL -- "-$pid" 2>/dev/null || true
fi`
export interface WslJob { file: string; args: string[]; cwd: string; stop(): void; binding: WslExecutionBinding }
export function createWslJob(binding: WslExecutionBinding, input: { command: string; timeoutMs: number; environment?: Record<string, string> } | { interactive: true }): WslJob {
  assertWslBinding(binding)
  const token = randomUUID()
  const environment = 'interactive' in input ? [] : Object.entries(input.environment ?? {}).map(([key, value]) => {
    if (!['NPM_CONFIG_REGISTRY', 'PIP_INDEX_URL'].includes(key) || value.includes('\0')) throw new Error('WSL 子进程环境变量无效。')
    return `${key}=${value}`
  })
  const command = 'interactive' in input ? ['/bin/sh', '-i']
    : ['/usr/bin/env', ...environment, '/usr/bin/timeout', '--signal=TERM', '--kill-after=2s', `${Math.max(1, Math.ceil(input.timeoutMs / 1000))}s`, '/bin/sh', '-c', input.command]
  return { binding, file: wslExecutable(), cwd: process.env.SystemRoot!,
    args: ['--distribution', binding.distribution, '--exec', '/bin/sh', '-c', 'interactive' in input ? OUTER.replace('setsid --wait ', 'setsid --wait --ctty ') : OUTER, 'caogen-job', binding.guestCwd, token, INNER, ...command],
    stop() {
      // Revalidate the distribution before addressing its namespace. If it was
      // replaced, no stop command is sent to the replacement environment.
      assertWslBinding(binding)
      runWslProbe(['--distribution', binding.distribution, '--exec', '/bin/sh', '-c', STOP, 'caogen-stop', token])
    } }
}
