import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkpointMatches, wakeAlarm } from '../scripts/wake-codex.mjs';
let dir: string;
let record: any;
let cursor: any;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-worker-test-'));
  record = { version: 1, token: 'alarm', sessionId: 'failed-chat', sessionFile: join(dir, 'session.jsonl'), leafId: 'failure', checkAt: 0, pid: -1, paneId: 'w1:p1', socketPath: '/fixture/socket', frozenDir: dir };
  cursor = { checkpointed: true, sessionId: record.sessionId, sessionFile: record.sessionFile, leafId: 'sleep' };
  writeFileSync(record.sessionFile, [JSON.stringify({ id: 'failure', type: 'message', message: { role: 'assistant', stopReason: 'error' } }), JSON.stringify({ id: 'sleep', parentId: 'failure', type: 'custom', customType: 'omp-sleep-anchor' })].join('\n'));
  writeFileSync(join(dir, 'alarm.json'), JSON.stringify(record));
  writeFileSync(join(dir, 'w1:p1.cursor.json'), JSON.stringify(cursor));
  writeFileSync(join(dir, 'w1:p1.ans'), 'parked');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
test('only the same failed branch plus a sleep anchor qualifies for automatic wakeup', () => {
  expect(checkpointMatches(record, cursor)).toBe(true);
  expect(checkpointMatches(record, { ...cursor, sessionId: 'another-chat' })).toBe(false);
  expect(checkpointMatches(record, { ...cursor, checkpointed: false })).toBe(false);
  writeFileSync(record.sessionFile, JSON.stringify({ id: 'sleep', parentId: 'failure', type: 'message', message: { role: 'user', content: 'new work' } }));
  expect(checkpointMatches(record, cursor)).toBe(false);
});
test('a deleted or replaced alarm cannot wake the old pane', () => {
  expect(wakeAlarm(join(dir, 'alarm.json'), 'old-token')).toBe('stale');
  rmSync(join(dir, 'alarm.json'));
  expect(wakeAlarm(join(dir, 'alarm.json'), 'alarm')).toBe('stale');
});
test('a closed pager never receives a wake key even if an old checkpoint remains', () => {
  rmSync(join(dir, 'w1:p1.ans'));
  expect(wakeAlarm(join(dir, 'alarm.json'), 'alarm')).toBe('closed');
});
test('cancellation during the process lookup fences wake delivery', () => {
  const run = () => {
    rmSync(join(dir, 'alarm.json'));
    return { status: 0, stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ argv: ['bash', '/bin/omp-frozen', record.sessionFile, cursor.leafId] }] } } }) };
  };
  expect(wakeAlarm(join(dir, 'alarm.json'), 'alarm', run)).toBe('stale');
});
test('an unrelated live shell never receives Enter from a stale alarm', () => {
  const run = () => ({ status: 0, stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ argv: ['/bin/bash'] }] } } }) });
  expect(wakeAlarm(join(dir, 'alarm.json'), 'alarm', run)).toBe('not-frozen');
});
