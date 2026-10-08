import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { processStamp } from '../lib/codex-alarm-state.mjs';
function readRecord(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; } }
export function checkpointMatches(record, cursor) {
  if (cursor?.checkpointed !== true || cursor.sessionId !== record.sessionId || cursor.sessionFile !== record.sessionFile || !cursor.leafId || !record.leafId) return false;
  try {
    const entries = new Map();
    for (const line of readFileSync(record.sessionFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line); if (entry.id) entries.set(entry.id, entry);
    }
    const visited = new Set();
    let id = cursor.leafId;
    while (id && !visited.has(id)) {
      if (id === record.leafId) return true;
      visited.add(id);
      const entry = entries.get(id);
      // Only the sleep checkpoint may extend the failed branch. New messages,
      // model switches, and other branch edits must never be revived by a stale alarm.
      if (entry?.type !== 'custom' || entry.customType !== 'omp-sleep-anchor') return false;
      id = entry.parentId;
    }
  } catch { /* Missing/corrupt history is not permission to wake a pane. */ }
  return false;
}
export function wakeAlarm(file, token, run = spawnSync) {
  const record = readRecord(file);
  if (!record || record.version !== 1 || record.token !== token || record.checkAt > Date.now()) return 'stale';
  const stamp = processStamp(record.pid);
  if (record.processStart && stamp?.start === record.processStart) {
    if (stamp.state === 'T' || stamp.state === 't') { process.kill(record.pid, 'SIGCONT'); return 'continued'; }
    return 'live';
  }
  if (!record.paneId || !record.socketPath || !record.frozenDir) return 'closed';
  const cursor = readRecord(join(record.frozenDir, record.paneId + '.cursor.json'));
  if (!existsSync(join(record.frozenDir, record.paneId + '.ans')) || !checkpointMatches(record, cursor)) return 'closed';
  const env = { ...process.env, PATH: record.path || process.env.PATH, HERDR_ENV: '1', HERDR_SOCKET_PATH: record.socketPath };
  const info = run('herdr', ['pane', 'process-info', '--pane', record.paneId], { env, encoding: 'utf8', timeout: 5000 });
  if (info.status !== 0) throw new Error('Herdr process lookup failed');
  const processes = JSON.parse(info.stdout).result?.process_info?.foreground_processes ?? [];
  const frozen = processes.some(process => Array.isArray(process.argv) && process.argv.some(arg => basename(arg) === 'omp-frozen') && process.argv.includes(record.sessionFile) && process.argv.includes(cursor.leafId));
  if (!frozen) return 'not-frozen';
  // Re-read after the Herdr lookup so cancellation/replacement fences delivery.
  if (readRecord(file)?.token !== token) return 'stale';
  const sent = run('herdr', ['pane', 'send-keys', record.paneId, 'enter'], { env, encoding: 'utf8', timeout: 5000 });
  if (sent.status !== 0) throw new Error('Herdr pane wake failed');
  return 'woken';
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify({ event: 'codex-external-wakeup', result: wakeAlarm(process.argv[2], process.argv[3]) })); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
