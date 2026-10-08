import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export function alarmPath(sessionId) {
  return join(process.env.CODEX_WAKEUP_STATE_DIR || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.omp', 'agent'), 'codex-wakeups'), createHash('sha256').update(sessionId).digest('hex') + '.json');
}
export function loadAlarm(sessionId) {
  try { const record = JSON.parse(readFileSync(alarmPath(sessionId), 'utf8')); return record.version === 1 && record.sessionId === sessionId ? record : undefined; } catch { return undefined; }
}
function unitName(sessionId) { return 'omp-codex-wakeup-' + createHash('sha256').update(sessionId).digest('hex').slice(0, 24); }
export function saveAlarm(record) {
  const file = alarmPath(record.sessionId);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID();
  writeFileSync(temporary, JSON.stringify({ ...record, version: 1 }), { mode: 0o600 });
  renameSync(temporary, file);
  return file;
}
export function scheduleExternal(record) {
  if (!record.paneId || !record.socketPath || process.platform !== 'linux') return false;
  const unit = unitName(record.sessionId);
  spawnSync('systemctl', ['--user', 'stop', unit + '.timer', unit + '.service'], { stdio: 'ignore', timeout: 5000 });
  const delay = Math.max(1, Math.ceil((record.checkAt - Date.now()) / 1000));
  const result = spawnSync('systemd-run', ['--user', '--collect', '--quiet', '--unit=' + unit, '--on-active=' + delay + 's', '--timer-property=AccuracySec=1s', '--property=Restart=on-failure', '--property=RestartSec=10s', '--property=StartLimitIntervalSec=0', '/usr/bin/env', 'node', fileURLToPath(new URL('../scripts/wake-codex.mjs', import.meta.url)), alarmPath(record.sessionId), record.token], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0;
}
export function deleteAlarm(sessionId) {
  const record = loadAlarm(sessionId);
  rmSync(alarmPath(sessionId), { force: true });
  if (record?.paneId && process.platform === 'linux') spawnSync('systemctl', ['--user', 'stop', unitName(sessionId) + '.timer', unitName(sessionId) + '.service'], { stdio: 'ignore', timeout: 5000 });
}
export function processStamp(pid) {
  try { const stat = readFileSync('/proc/' + pid + '/stat', 'utf8'); const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); return { state: fields[0], start: fields[19] }; } catch { return undefined; }
}
