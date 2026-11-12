'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(ROOT, 'cli.js');
const DOCTOR_PATH = path.join(ROOT, 'scripts', 'doctor.js');
const SETUP_PATH = path.join(ROOT, 'scripts', 'setup_wizard.js');

const doctor = require('../scripts/doctor.js');
const setupWizard = require('../scripts/setup_wizard.js');
const cli = require('../cli.js');

function runNode(args, opts = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...opts.env },
    ...opts,
  });
}

test('cli: prints help when invoked with --help or help', () => {
  for (const flag of ['--help', '-h', 'help']) {
    const res = runNode([CLI_PATH, flag]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /FreeDeepseekAPI CLI/i);
    assert.match(res.stdout, /Usage:/i);
    assert.match(res.stdout, /doctor/i);
    assert.match(res.stdout, /setup/i);
    assert.match(res.stdout, /service/i);
    assert.match(res.stdout, /auth/i);
  }
});

test('cli: prints version when invoked with --version or -v', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const flag of ['--version', '-v']) {
    const res = runNode([CLI_PATH, flag]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, new RegExp(pkg.version));
  }
});

test('cli: exits with 1 on unknown command', () => {
  const res = runNode([CLI_PATH, 'non-existent-subcommand-xyz']);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /Unknown command: non-existent-subcommand-xyz/i);
});

test('cli: non-interactive invocation without tty shows help', () => {
  const res = runNode([CLI_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /FreeDeepseekAPI CLI/i);
});

test('cli: service status returns actionable message when unit is not installed', () => {
  if (process.platform === 'linux') {
    const res = runNode([CLI_PATH, 'service', 'status']);
    const out = res.stdout + res.stderr;
    assert.match(out, /(free-deepseek-api\.service|active|inactive|not installed)/i);
  } else {
    const res = runNode([CLI_PATH, 'service', 'status']);
    assert.match(res.stdout, /Linux only/i);
  }
});

test('cli: auth status checks candidate accounts without crashing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-cli-auth-'));
  const testAuth = path.join(tmp, 'deepseek-auth.json');
  fs.writeFileSync(
    testAuth,
    JSON.stringify({
      token: 'a'.repeat(64),
      cookie: 'ds_session_id=fake_session_123',
      wasmUrl: 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm',
    }),
    { mode: 0o600 }
  );

  const res = runNode([CLI_PATH, 'auth', 'status'], {
    env: { DEEPSEEK_AUTH_PATH: testAuth },
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Format: 64-hex/i);
  assert.match(res.stdout, /ds_session_id/i);
});

test('doctor: checkNodeVersion detects current runtime correctly', () => {
  const res = doctor.checkNodeVersion();
  assert.ok(['ok', 'warn'].includes(res.status));
  assert.match(res.version, /^v\d+/);
});

test('doctor: checkBrowser detects browser or returns warning', () => {
  const res = doctor.checkBrowser();
  assert.ok(['ok', 'warn'].includes(res.status));
  assert.ok(typeof res.message === 'string');
});

test('doctor: checkAuthFile validates missing and invalid files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-doc-test-'));
  const missingFile = path.join(tmp, 'missing.json');
  const missingRes = doctor.checkAuthFile(missingFile);
  assert.equal(missingRes.ok, false);
  assert.ok(missingRes.issues.includes('auth file missing'));

  const badJsonFile = path.join(tmp, 'bad.json');
  fs.writeFileSync(badJsonFile, '{ bad json');
  const badJsonRes = doctor.checkAuthFile(badJsonFile);
  assert.equal(badJsonRes.ok, false);
  assert.match(badJsonRes.issues[0], /invalid JSON/i);

  const incompleteFile = path.join(tmp, 'incomplete.json');
  fs.writeFileSync(incompleteFile, JSON.stringify({ token: 'abc' }));
  const incRes = doctor.checkAuthFile(incompleteFile);
  assert.equal(incRes.ok, false);
  assert.ok(incRes.issues.includes('cookie missing'));
  assert.ok(incRes.issues.includes('wasmUrl missing'));
});

test('doctor: runDoctor offline returns structured diagnostics', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-doc-run-'));
  const validAuth = path.join(tmp, 'deepseek-auth.json');
  fs.writeFileSync(
    validAuth,
    JSON.stringify({
      token: 'b'.repeat(64),
      cookie: 'ds_session_id=test_cookie',
      wasmUrl: 'https://example.com/sha3.wasm',
    }),
    { mode: 0o600 }
  );

  const originalEnv = process.env.DEEPSEEK_AUTH_PATH;
  try {
    process.env.DEEPSEEK_AUTH_PATH = validAuth;
    const report = await doctor.runDoctor({ offline: true });
    assert.ok(report.timestamp);
    assert.ok(report.node);
    assert.ok(report.browser);
    assert.ok(report.accounts.length >= 1);
    assert.equal(report.accounts[0].ok, true);
  } finally {
    process.env.DEEPSEEK_AUTH_PATH = originalEnv;
  }
});

test('doctor: CLI --json flag produces valid JSON output', () => {
  const res = runNode([DOCTOR_PATH, '--offline', '--json']);
  let json;
  try {
    json = JSON.parse(res.stdout);
  } catch (e) {
    assert.fail(`Doctor --json output was not valid JSON: ${e.message}\nOutput: ${res.stdout}`);
  }
  assert.ok(json.timestamp);
  assert.ok(json.node);
  assert.ok(json.summary);
});

test('setup_wizard: parseArgs parses options accurately', () => {
  const parsed = setupWizard.parseArgs([
    '--non-interactive',
    '--port=8888',
    '--host=0.0.0.0',
    '--api-key=secret123',
    '--skip-browser',
    '--skip-service',
    '--offline',
  ]);
  assert.equal(parsed.nonInteractive, true);
  assert.equal(parsed.port, '8888');
  assert.equal(parsed.host, '0.0.0.0');
  assert.equal(parsed.apiKey, 'secret123');
  assert.equal(parsed.skipBrowser, true);
  assert.equal(parsed.skipService, true);
  assert.equal(parsed.offline, true);
});

test('setup_wizard: updateEnvFile creates or updates .env keys', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-env-test-'));
  const envFile = path.join(tmp, '.env');

  setupWizard.updateEnvFile(envFile, {
    PORT: '9700',
    HOST: '127.0.0.1',
    PROXY_API_KEY: 'test-key-abc',
  });

  const content = fs.readFileSync(envFile, 'utf8');
  assert.match(content, /PORT="9700"/);
  assert.match(content, /HOST="127.0.0.1"/);
  assert.match(content, /PROXY_API_KEY="test-key-abc"/);

  // Update existing key
  setupWizard.updateEnvFile(envFile, {
    PORT: '9800',
  });
  const updatedContent = fs.readFileSync(envFile, 'utf8');
  assert.match(updatedContent, /PORT="9800"/);
  assert.doesNotMatch(updatedContent, /PORT="9700"/);
  assert.match(updatedContent, /PROXY_API_KEY="test-key-abc"/);
});

test('setup_wizard: runs non-interactively with CLI flags without error', () => {
  const res = runNode([SETUP_PATH, '--non-interactive', '--skip-browser', '--skip-service', '--offline']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Setup Completed Successfully/i);
});

test('security & architecture: zero heavy npm dependencies and zero forbidden branding', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0, 'Must keep zero production dependencies');

  const filesToCheck = ['cli.js', 'scripts/doctor.js', 'scripts/setup_wizard.js'];
  const forbidden = ['forgetmeai', 't.me/forgetmeai', 'watermark('];

  for (const rel of filesToCheck) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8').toLowerCase();
    for (const term of forbidden) {
      assert.equal(text.includes(term.toLowerCase()), false, `Forbidden term "${term}" found in ${rel}`);
    }
  }
});
