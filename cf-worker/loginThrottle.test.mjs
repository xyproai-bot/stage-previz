// 跑法：cd cf-worker && npm test（= node --test loginThrottle.test.mjs）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loginThrottleDecision, loginLockedMessage, loginClientKey, shareAttemptKey,
  LOGIN_WINDOW_MS, LOGIN_LOCK_MS,
} from './loginThrottle.mjs';

const MIN = 60 * 1000;
const NOW = 1_800_000_000_000;

// n 次錯誤，最後一次在 lastAgo 之前，每次間隔 gap
function failures(n, lastAgo = 0, gap = 1000) {
  return Array.from({ length: n }, (_, i) => NOW - lastAgo - (n - 1 - i) * gap);
}

test('沒有錯誤 → 可以試', () => {
  assert.deepEqual(loginThrottleDecision([], NOW), { allowed: true, retryAfterMs: 0 });
  assert.deepEqual(loginThrottleDecision(undefined, NOW), { allowed: true, retryAfterMs: 0 });
});

test('錯 9 次 → 還可以試（第 10 次照常回答錯）', () => {
  assert.equal(loginThrottleDecision(failures(9), NOW).allowed, true);
});

test('錯 10 次 → 第 11 次被擋，剩約 15 分鐘', () => {
  const d = loginThrottleDecision(failures(10), NOW);
  assert.equal(d.allowed, false);
  assert.equal(d.retryAfterMs, LOGIN_LOCK_MS);
});

test('鎖定從第 10 次錯算起 15 分鐘，時間到就放行', () => {
  const f = failures(10, 0);
  assert.equal(loginThrottleDecision(f, NOW + LOGIN_LOCK_MS - 1).allowed, false);
  assert.equal(loginThrottleDecision(f, NOW + LOGIN_LOCK_MS - 1).retryAfterMs, 1);
  assert.deepEqual(loginThrottleDecision(f, NOW + LOGIN_LOCK_MS), { allowed: true, retryAfterMs: 0 });
});

test('超過 15 分鐘的舊錯誤不算', () => {
  // 5 次很久以前 + 5 次剛剛 → 視窗內只有 5 次
  const old = failures(5, LOGIN_WINDOW_MS + 5 * MIN);
  const recent = failures(5, 0);
  assert.equal(loginThrottleDecision([...old, ...recent], NOW).allowed, true);
});

test('10 次分散在 15 分鐘之外 → 沒鎖', () => {
  // 每 2 分鐘錯一次，連錯 10 次 → 任何 15 分鐘內最多 8 次
  assert.equal(loginThrottleDecision(failures(10, 0, 2 * MIN), NOW).allowed, true);
});

test('順序亂、有怪值也不會出錯', () => {
  const f = failures(10).reverse();
  f.push(NaN, 'x', NOW + 10 * MIN);
  assert.equal(loginThrottleDecision(f, NOW).allowed, false);
});

test('鎖定期間不記錯 → 鎖完歸零重算', () => {
  const f = failures(10, 0);
  const after = NOW + LOGIN_LOCK_MS;
  // 鎖完再錯 9 次 → 還可以試
  const more = Array.from({ length: 9 }, (_, i) => after + i * 1000);
  assert.equal(loginThrottleDecision([...f, ...more], after + 9000).allowed, true);
});

test('訊息顯示剩幾分鐘（至少 1）', () => {
  assert.equal(loginLockedMessage(LOGIN_LOCK_MS), '錯太多次了，請 15 分鐘後再試');
  assert.equal(loginLockedMessage(61 * 1000), '錯太多次了，請 2 分鐘後再試');
  assert.equal(loginLockedMessage(5), '錯太多次了，請 1 分鐘後再試');
});

test('IP key：IPv4 原樣、IPv6 取 /64、沒有 → unknown', () => {
  assert.equal(loginClientKey('203.0.113.7'), '203.0.113.7');
  assert.equal(loginClientKey(' 203.0.113.7, 10.0.0.1'), '203.0.113.7');
  assert.equal(loginClientKey(''), 'unknown');
  assert.equal(loginClientKey(null), 'unknown');
  assert.equal(loginClientKey('2001:db8:abcd:12:1:2:3:4'), '2001:db8:abcd:12::/64');
  assert.equal(loginClientKey('2001:0DB8:abcd:0012::99'), '2001:db8:abcd:12::/64');
  assert.equal(loginClientKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(loginClientKey('::1'), '0:0:0:0::/64');
  assert.equal(loginClientKey('::ffff:198.51.100.2'), '198.51.100.2');
  assert.equal(loginClientKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
});

test('分享密碼 key：每條連結、每個 IP 分開算，不會跟登入的 key 撞', () => {
  const ip = loginClientKey('203.0.113.7');
  assert.equal(shareAttemptKey('abc123', ip), 'share:abc123|203.0.113.7');
  assert.notEqual(shareAttemptKey('abc123', ip), shareAttemptKey('def456', ip));
  assert.notEqual(shareAttemptKey('abc123', ip), shareAttemptKey('abc123', loginClientKey('198.51.100.2')));
  assert.notEqual(shareAttemptKey('abc123', ip), ip);
  assert.ok(!ip.startsWith('share:'));
  assert.equal(shareAttemptKey('abc123', loginClientKey('')), 'share:abc123|unknown');
  assert.equal(shareAttemptKey('t', null), 'share:t|unknown');
});
