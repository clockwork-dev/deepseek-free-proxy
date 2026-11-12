'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const pool = require('../src/accounts/pool');

test('buildBaseHeaders: generates standard DeepSeek headers', () => {
  const config = {
    token: 'test_token_123',
    cookie: 'ds_session_id=session_456',
    hif_dliq: 'dliq_val',
    hif_leim: 'leim_val',
  };

  const headers = pool.buildBaseHeaders(config);
  assert.equal(headers['Authorization'], 'Bearer test_token_123');
  assert.equal(headers['Cookie'], 'ds_session_id=session_456');
  assert.equal(headers['x-hif-dliq'], 'dliq_val');
  assert.equal(headers['x-hif-leim'], 'leim_val');
  assert.equal(headers['x-client-platform'], 'web');
  assert.match(headers['User-Agent'], /Chrome\//);
});

test('discoverAuthPaths: supports comma-separated list and directory', () => {
  const origDir = process.env.DEEPSEEK_AUTH_DIR;
  const origPath = process.env.DEEPSEEK_AUTH_PATH;

  try {
    // 1. Default path contains fallback config path
    delete process.env.DEEPSEEK_AUTH_DIR;
    delete process.env.DEEPSEEK_AUTH_PATH;
    assert.equal(pool.discoverAuthPaths().length, 1);
    assert.match(pool.discoverAuthPaths()[0], /deepseek-auth\.json/);

    // 2. Comma separated list
    process.env.DEEPSEEK_AUTH_PATH = '/path/1.json, /path/2.json , /path/3.json';
    assert.deepEqual(pool.discoverAuthPaths(), ['/path/1.json', '/path/2.json', '/path/3.json']);

    // 3. Directory of accounts
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-pool-test-'));
    fs.writeFileSync(path.join(tmp, 'b.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'a.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'ignored.txt'), 'text');
    process.env.DEEPSEEK_AUTH_DIR = tmp;

    const discovered = pool.discoverAuthPaths();
    assert.equal(discovered.length, 2);
    assert.equal(path.basename(discovered[0]), 'a.json'); // Sorted
    assert.equal(path.basename(discovered[1]), 'b.json');
  } finally {
    if (origDir !== undefined) process.env.DEEPSEEK_AUTH_DIR = origDir;
    else delete process.env.DEEPSEEK_AUTH_DIR;
    if (origPath !== undefined) process.env.DEEPSEEK_AUTH_PATH = origPath;
    else delete process.env.DEEPSEEK_AUTH_PATH;
  }
});

test('accountStatus: reports readiness and cooldown details accurately', () => {
  const now = Date.now();
  const accountReady = {
    id: 'acct_1',
    config: { token: 't', cookie: 'c' },
    cooldownUntil: 0,
    failures: 1,
    lastUsedAt: now - 5000,
  };
  const statusReady = pool.accountStatus(accountReady);
  assert.equal(statusReady.id, 'acct_1');
  assert.equal(statusReady.ready, true);
  assert.equal(statusReady.cooldown, false);
  assert.equal(statusReady.cooldown_remaining_sec, 0);
  assert.equal(statusReady.failures, 1);

  const accountCooling = {
    id: 'acct_2',
    config: { token: 't', cookie: 'c' },
    cooldownUntil: now + 30000,
    failures: 3,
    lastUsedAt: now,
  };
  const statusCooling = pool.accountStatus(accountCooling);
  assert.equal(statusCooling.id, 'acct_2');
  assert.equal(statusCooling.cooldown, true);
  assert.ok(statusCooling.cooldown_remaining_sec >= 25 && statusCooling.cooldown_remaining_sec <= 30);
});

test('parseRetryAfterMs: handles delta-seconds, HTTP dates, and invalid values', () => {
  // Delta seconds
  assert.equal(pool.parseRetryAfterMs('120'), 120000);
  assert.equal(pool.parseRetryAfterMs('0'), 1000); // Clamped to min 1s

  // Future HTTP Date
  const futureSec = 15;
  const futureDate = new Date(Date.now() + futureSec * 1000).toUTCString();
  const parsedFuture = pool.parseRetryAfterMs(futureDate);
  assert.ok(parsedFuture >= 13000 && parsedFuture <= 17000);

  // Past HTTP Date -> clamped to 1000ms
  const pastDate = new Date(Date.now() - 50000).toUTCString();
  assert.equal(pool.parseRetryAfterMs(pastDate), 1000);

  // Missing or unparseable
  assert.equal(pool.parseRetryAfterMs(null), null);
  assert.equal(pool.parseRetryAfterMs(''), null);
  assert.equal(pool.parseRetryAfterMs('not-a-date-or-number'), null);
});

test('selectAccountForSession: round-robin selection and session stickiness', () => {
  pool.accounts.splice(0, pool.accounts.length,
    { id: 'acct_1', config: { token: 't1', cookie: 'c1' }, cooldownUntil: 0, failures: 0, lastUsedAt: 0 },
    { id: 'acct_2', config: { token: 't2', cookie: 'c2' }, cooldownUntil: 0, failures: 0, lastUsedAt: 0 }
  );

  const session1 = { id: 's1', accountId: null };
  const session2 = { id: 's2', accountId: null };

  const selected1 = pool.selectAccountForSession(session1);
  const selected2 = pool.selectAccountForSession(session2);

  // Round-robin assignment
  assert.notEqual(selected1.id, selected2.id);
  assert.equal(session1.accountId, selected1.id);
  assert.equal(session2.accountId, selected2.id);

  // Sticky assignment on subsequent call
  const reselected1 = pool.selectAccountForSession(session1);
  assert.equal(reselected1.id, selected1.id);

  // If sticky account cools down, switches to ready account
  selected1.cooldownUntil = Date.now() + 60000;
  const switched = pool.selectAccountForSession(session1);
  assert.equal(switched.id, selected2.id);
});

test('selectAccountForSession: throws 429 when all accounts on cooldown', () => {
  const future = Date.now() + 45000;
  pool.accounts.splice(0, pool.accounts.length,
    { id: 'acct_1', config: { token: 't1', cookie: 'c1' }, cooldownUntil: future, failures: 1, lastUsedAt: 0 },
    { id: 'acct_2', config: { token: 't2', cookie: 'c2' }, cooldownUntil: future + 10000, failures: 1, lastUsedAt: 0 }
  );

  const session = { id: 's_cd', accountId: null };
  assert.throws(() => pool.selectAccountForSession(session), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.type, 'rate_limit');
    assert.ok(err.retryAfter >= 40 && err.retryAfter <= 46);
    return true;
  });
});

test('selectAccountForSession: throws 503 when no auth accounts available', () => {
  pool.accounts.splice(0, pool.accounts.length);
  const session = { id: 's_empty', accountId: null };
  assert.throws(() => pool.selectAccountForSession(session), (err) => {
    assert.equal(err.status, 503);
    assert.equal(err.type, 'no_auth');
    return true;
  });
});

test('markAccountFailure: tracks failures and sets cooldown on 401, 403, 429', () => {
  const acct = { id: 'acct_f', config: { token: 't', cookie: 'c' }, cooldownUntil: 0, failures: 0, lastUsedAt: 0 };

  // Transient 500 error does not trigger cooldown
  pool.markAccountFailure(acct, 500, 'internal error');
  assert.equal(acct.failures, 1);
  assert.equal(acct.cooldownUntil, 0);

  // 429 error triggers cooldown
  const now = Date.now();
  pool.markAccountFailure(acct, 429, 'too many requests', '30');
  assert.equal(acct.failures, 2);
  assert.ok(acct.cooldownUntil >= now + 29000);
});

test('hasOtherReadyAccount: checks if alternative account is ready', () => {
  pool.accounts.splice(0, pool.accounts.length,
    { id: 'acct_a', config: { token: 't1', cookie: 'c1' }, cooldownUntil: 0, failures: 0, lastUsedAt: 0 },
    { id: 'acct_b', config: { token: 't2', cookie: 'c2' }, cooldownUntil: Date.now() + 50000, failures: 1, lastUsedAt: 0 }
  );

  assert.equal(pool.hasOtherReadyAccount('acct_a'), false); // acct_b is cooling down
  assert.equal(pool.hasOtherReadyAccount('acct_b'), true); // acct_a is ready
});

test('isAccountLevelError: distinguishes account-level vs request-level errors', () => {
  assert.equal(pool.isAccountLevelError({ status: 401 }), true);
  assert.equal(pool.isAccountLevelError({ status: 403 }), true);
  assert.equal(pool.isAccountLevelError({ status: 429 }), true);
  assert.equal(pool.isAccountLevelError({ status: 500 }), false);
  assert.equal(pool.isAccountLevelError({ status: 400 }), false);
  assert.equal(pool.isAccountLevelError(null), false);
});
