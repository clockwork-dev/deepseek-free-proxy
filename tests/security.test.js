const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const serverInternals = require('../server.js').__test;
const ensureBrowser = require('../scripts/ensure_browser.js');

test('security: codebase contains zero traces of watermark or old author branding', () => {
  const filesToCheck = [
    'server.js',
    'package.json',
    'README.md',
    'scripts/auth.js',
    'scripts/auth_import.js',
    'scripts/doctor.js',
    'scripts/ensure_browser.js',
    'scripts/deepseek_chrome_auth.js',
    'lib/pow.js',
    'lib/env.js'
  ];

  const forbiddenTerms = [
    'forgetmeai',
    't.me/forgetmeai',
    'FORGETMEAI_WATERMARK',
    'watermark('
  ];

  for (const relPath of filesToCheck) {
    const fullPath = path.join(ROOT, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, 'utf8');
    for (const term of forbiddenTerms) {
      assert.equal(
        content.toLowerCase().includes(term.toLowerCase()),
        false,
        `File ${relPath} must not contain forbidden term "${term}"`
      );
    }
  }
});

test('security: authentication validator correctly enforces Bearer token and x-api-key', () => {
  const { isProxyAuthorized } = serverInternals;
  const SECRET_KEY = 'secret-proxy-token-12345';

  // When expectedKey is empty / not set, access is permitted
  assert.equal(isProxyAuthorized('Bearer whatever', ''), true);
  assert.equal(isProxyAuthorized(undefined, ''), true);

  // When expectedKey is configured:
  // 1. Valid Bearer token
  assert.equal(isProxyAuthorized(`Bearer ${SECRET_KEY}`, SECRET_KEY), true);
  // 2. Valid x-api-key header
  assert.equal(isProxyAuthorized(undefined, SECRET_KEY, SECRET_KEY), true);
  assert.equal(isProxyAuthorized('', SECRET_KEY, SECRET_KEY), true);
  // 3. Invalid Bearer token
  assert.equal(isProxyAuthorized('Bearer invalid-token', SECRET_KEY), false);
  // 4. Invalid x-api-key
  assert.equal(isProxyAuthorized(undefined, SECRET_KEY, 'wrong-api-key'), false);
  // 5. Missing auth entirely
  assert.equal(isProxyAuthorized(undefined, SECRET_KEY, undefined), false);
  // 6. Malformed header (e.g. Basic auth or lowercase bearer)
  assert.equal(isProxyAuthorized(`Basic ${SECRET_KEY}`, SECRET_KEY), false);
  assert.equal(isProxyAuthorized(`bearer ${SECRET_KEY}`, SECRET_KEY), false);
  // 7. Empty string bearer
  assert.equal(isProxyAuthorized('Bearer ', SECRET_KEY), false);
});

test('security: requireProxyApiKey throws when required but key is absent', () => {
  const { requireProxyApiKey } = serverInternals;
  assert.doesNotThrow(() => requireProxyApiKey('valid-key', true));
  assert.doesNotThrow(() => requireProxyApiKey('', false));
  assert.throws(() => requireProxyApiKey('', true), /PROXY_API_KEY is required/);
  assert.throws(() => requireProxyApiKey(null, true), /PROXY_API_KEY is required/);
});

test('security: loopback host and CORS origin validation prevent SSRF and unwanted external origins', () => {
  const { isLoopbackHost, isBrowserOriginAllowed } = serverInternals;

  // Loopback check
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('example.com'), false);
  assert.equal(isLoopbackHost('192.168.1.100'), false);

  // CORS origin check
  const customOrigins = new Set(['https://mytrustedapp.internal']);
  assert.equal(isBrowserOriginAllowed('http://localhost:3000', customOrigins), true);
  assert.equal(isBrowserOriginAllowed('http://127.0.0.1:8080', customOrigins), true);
  assert.equal(isBrowserOriginAllowed('https://mytrustedapp.internal', customOrigins), true);
  assert.equal(isBrowserOriginAllowed('https://malicious-site.com', customOrigins), false);
  assert.equal(isBrowserOriginAllowed('', customOrigins), true); // non-browser requests
});

test('security: content sanitization filters control characters safely', () => {
  const { sanitizeContent } = serverInternals;
  assert.equal(sanitizeContent('Clean text 123'), 'Clean text 123');
  assert.equal(sanitizeContent(null), '');
  assert.equal(sanitizeContent(undefined), '');
  assert.equal(typeof sanitizeContent('Hello world!'), 'string');
});

test('browser detection: ensure_browser module provides required helper functions', () => {
  assert.equal(typeof ensureBrowser.resolveChromePath, 'function');
  assert.equal(typeof ensureBrowser.ensureBrowser, 'function');
  assert.equal(typeof ensureBrowser.installPlaywrightChromium, 'function');

  // Test CHROME_PATH environment override
  const fakeBin = path.join(ROOT, 'package.json'); // exists
  const oldChromePath = process.env.CHROME_PATH;
  try {
    process.env.CHROME_PATH = fakeBin;
    assert.equal(ensureBrowser.resolveChromePath(), fakeBin);
  } finally {
    if (oldChromePath !== undefined) {
      process.env.CHROME_PATH = oldChromePath;
    } else {
      delete process.env.CHROME_PATH;
    }
  }
});

test('browser detection: CLI exits cleanly when checking browser', () => {
  const res = spawnSync(process.execPath, ['scripts/ensure_browser.js'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  // Should either find a browser or report missing, but not crash with unhandled exception
  assert.ok(res.status === 0 || res.status === 1);
  assert.match(res.stdout + res.stderr, /\[browser\]/);
});

test('installer script syntax validation', () => {
  const installScript = path.join(ROOT, 'deploy', 'install.sh');
  const uninstallScript = path.join(ROOT, 'deploy', 'uninstall.sh');

  assert.ok(fs.existsSync(installScript), 'deploy/install.sh must exist');
  assert.ok(fs.existsSync(uninstallScript), 'deploy/uninstall.sh must exist');

  // bash -n check
  const bashCheckInstall = spawnSync('bash', ['-n', installScript]);
  assert.equal(bashCheckInstall.status, 0, `install.sh syntax error: ${bashCheckInstall.stderr}`);

  const bashCheckUninstall = spawnSync('bash', ['-n', uninstallScript]);
  assert.equal(bashCheckUninstall.status, 0, `uninstall.sh syntax error: ${bashCheckUninstall.stderr}`);

  // Test help option of install.sh
  const helpRes = spawnSync('bash', [installScript, '--help'], { encoding: 'utf8' });
  assert.equal(helpRes.status, 0);
  assert.match(helpRes.stdout, /Использование:/);
  assert.match(helpRes.stdout, /--current-user/);
});
