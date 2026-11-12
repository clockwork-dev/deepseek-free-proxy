const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function makeTempDir(prefix = 'deepseek-install-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readUtf8(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function extractBashFunction(scriptContent, fnName) {
  const lines = scriptContent.split(/\r?\n/);
  const startRe = new RegExp(`^([ \\t]*)${fnName}\\(\\)\\s*\\{`);
  let indent = '';
  const startIdx = lines.findIndex(line => {
    const m = line.match(startRe);
    if (!m) return false;
    indent = m[1];
    return true;
  });
  assert.notEqual(startIdx, -1, `Expected bash function ${fnName}() to exist`);
  const endRe = new RegExp(`^${indent}\\}$`);
  const endIdx = lines.findIndex((line, idx) => idx > startIdx && endRe.test(line));
  assert.notEqual(endIdx, -1, `Expected closing brace for bash function ${fnName}()`);
  return lines.slice(startIdx, endIdx + 1).join('\n');
}

function listJsFiles(dirRel) {
  const out = [];
  const base = path.join(ROOT, dirRel);
  if (!fs.existsSync(base)) return out;
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    const rel = path.join(dirRel, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsFiles(rel));
    } else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

const HAS_BASH = process.platform !== 'win32' &&
  spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;

test('all shell scripts pass bash -n syntax validation', { skip: !HAS_BASH }, () => {
  const scripts = [
    'deploy/quick-install.sh',
    'deploy/install.sh',
    'deploy/uninstall.sh',
    'scripts/install_service.sh',
    'scripts/uninstall_service.sh',
  ];

  for (const rel of scripts) {
    const abs = path.join(ROOT, rel);
    assert.equal(fs.existsSync(abs), true, `Missing script ${rel}`);
    const res = spawnSync('bash', ['-n', abs], { encoding: 'utf8' });
    assert.equal(res.status, 0, `bash -n failed for ${rel}:\n${res.stderr}`);
  }
});

test('deploy scripts enforce strict shell safety, umask, pipe safety, and valid JSON placeholders', () => {
  const quickInstall = readUtf8('deploy/quick-install.sh');
  const install = readUtf8('deploy/install.sh');
  const uninstall = readUtf8('deploy/uninstall.sh');

  for (const [name, content] of [
    ['deploy/quick-install.sh', quickInstall],
    ['deploy/install.sh', install],
    ['deploy/uninstall.sh', uninstall],
  ]) {
    assert.match(content, /^set -euo pipefail$/m, `${name} must set -euo pipefail`);
    assert.doesNotMatch(content, /\/opt\/FreeDeepseekAPI/, `${name} must not hardcode legacy /opt/FreeDeepseekAPI`);
  }

  // curl | bash safety: entire script parsed inside main() before execution
  assert.match(quickInstall, /^main\(\) \{/m);
  assert.match(quickInstall, /\nmain "\$@"\s*$/);
  // Safe /dev/tty interactive prompting when stdin is piped
  assert.match(quickInstall, /\/dev\/tty/);
  // Never execute /etc/os-release as shell code
  assert.doesNotMatch(quickInstall, /(?:^|\s)(?:source|\.)\s+\/etc\/os-release/m);
  assert.match(quickInstall, /\/etc\/os-release/);
  // Restrictive permissions for generated env / auth files
  assert.match(quickInstall, /umask 077/);
  assert.match(quickInstall, /chmod 0?600/);
  // Empty placeholder JSON must be "{}" and preserve populated configs
  assert.match(quickInstall, /printf '\{\}\\n'/);
  assert.doesNotMatch(quickInstall, /echo '\{\s+\}'/);

  // install.sh security & preflight hardening
  assert.match(install, /umask 077/);
  assert.match(install, /chmod 0?600/);
  assert.match(install, /printf '\{\}\\n'/);
  assert.match(install, /WorkingDirectory=\$PROJECT_DIR\b/);
  assert.match(install, /EnvironmentFile=-\$ENV_FILE\b/);
  assert.match(install, /ProtectHome=\$PROTECT_HOME\b/);
  assert.match(install, /run_as_service_user test -r "\$PROJECT_DIR\/server\.js"/);
  assert.match(install, /ExecStart=\$EXEC_START_LINE\b/);

  // uninstall.sh supports macOS LaunchAgent and non-systemd Linux environments
  assert.match(uninstall, /PLIST_LABEL="com\.deepseek\.free-proxy"/);
  assert.match(uninstall, /\$\{PLIST_LABEL\}\.plist/);
  assert.match(uninstall, /--purge/);
  assert.match(uninstall, /\/run\/systemd\/system/);
});

test('deploy/uninstall.sh handles --help and macOS LaunchAgent removal cleanly', { skip: !HAS_BASH }, () => {
  const uninstallPath = path.join(ROOT, 'deploy/uninstall.sh');
  const helpRes = spawnSync('bash', [uninstallPath, '--help'], { encoding: 'utf8' });
  assert.equal(helpRes.status, 0, helpRes.stderr);
  assert.match(helpRes.stdout, /--purge/);

  const tmpDir = makeTempDir('deepseek-uninstall-test-');
  try {
    const fakeHome = path.join(tmpDir, 'home');
    const agentsDir = path.join(fakeHome, 'Library', 'LaunchAgents');
    const logsDir = path.join(fakeHome, 'Library', 'Logs', 'deepseek-free-proxy');
    const toolsDir = path.join(tmpDir, 'tools');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(toolsDir, { recursive: true });

    const plistFile = path.join(agentsDir, 'com.deepseek.free-proxy.plist');
    fs.writeFileSync(plistFile, '<plist/>', 'utf8');
    fs.writeFileSync(path.join(logsDir, 'stdout.log'), 'log', 'utf8');
    fs.writeFileSync(path.join(toolsDir, 'launchctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const res = spawnSync(
      'bash',
      ['-c', `uname() { echo "Darwin"; }; export -f uname; HOME="${fakeHome}" PATH="${toolsDir}:$PATH" bash "${uninstallPath}" --purge`],
      { encoding: 'utf8' },
    );
    assert.equal(res.status, 0, `macOS uninstall test failed:\n${res.stderr}\n${res.stdout}`);
    assert.equal(fs.existsSync(plistFile), false, 'LaunchAgent plist should be deleted');
    assert.equal(fs.existsSync(logsDir), false, 'LaunchAgent logs dir should be removed under --purge');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('deploy/free-deepseek-api.service template uses safe defaults and documents dynamic overrides', () => {
  const unit = readUtf8('deploy/free-deepseek-api.service');

  assert.match(unit, /TEMPLATE ONLY/i);
  assert.doesNotMatch(unit, /\/opt\/FreeDeepseekAPI/);
  assert.match(unit, /^WorkingDirectory=\/opt\/deepseek-free-proxy$/m);
  assert.match(unit, /^EnvironmentFile=-\/etc\/free-deepseek-api\/env$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/env node server\.js$/m);
  assert.match(unit, /^ProtectHome=true$/m);
  assert.match(unit, /ProtectHome=read-only/);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^PrivateTmp=true$/m);

  // Run systemd-analyze verify when available
  const which = spawnSync('which', ['systemd-analyze'], { encoding: 'utf8' });
  if (process.platform === 'linux' && which.status === 0) {
    const verify = spawnSync('systemd-analyze', ['verify', path.join(ROOT, 'deploy/free-deepseek-api.service')], {
      encoding: 'utf8',
    });
    assert.equal(verify.status, 0, `systemd-analyze verify failed:\n${verify.stderr || verify.stdout}`);
  }
});

test('deploy/install.sh --help works non-root and adaptive is_under_home_or_root selects ProtectHome safely', { skip: !HAS_BASH }, () => {
  const helpRes = spawnSync('bash', [path.join(ROOT, 'deploy/install.sh'), '--help'], { encoding: 'utf8' });
  assert.equal(helpRes.status, 0, `install.sh --help failed:\n${helpRes.stderr}`);
  assert.match(helpRes.stdout, /--protect-home/);
  assert.match(helpRes.stdout, /--install-dir/);
  assert.match(helpRes.stdout, /--service-user/);
  assert.match(helpRes.stdout, /--current-user/);
  assert.doesNotMatch(helpRes.stdout, /\/opt\/FreeDeepseekAPI/);

  if (process.platform !== 'linux') return;

  const installContent = readUtf8('deploy/install.sh');
  const canonicalFn = extractBashFunction(installContent, 'canonical_path');
  const underHomeFn = extractBashFunction(installContent, 'is_under_home_or_root');

  const tmpDir = makeTempDir('deepseek-protect-home-');
  try {
    let symlinkLine = 'echo "SYMLINK=true"';
    if (fs.existsSync('/home')) {
      const linkPath = path.join(tmpDir, 'home-symlink');
      fs.symlinkSync('/home', linkPath);
      symlinkLine = `if is_under_home_or_root "${linkPath}/project"; then echo "SYMLINK=true"; else echo "SYMLINK=false"; fi`;
    }

    const script = `
set -euo pipefail
${canonicalFn}
${underHomeFn}
check() {
  local label="$1"
  local target="$2"
  if is_under_home_or_root "$target"; then
    echo "$label=true"
  else
    echo "$label=false"
  fi
}
check OPT "/opt/deepseek-free-proxy"
check USR "/usr/local/bin/node"
check ETC "/etc/free-deepseek-api/env"
check HOME_SUB "/home/alice/deepseek-free-proxy"
check ROOT_SUB "/root/.nvm/versions/node/v22.0.0/bin/node"
check HOME_DIR "/home"
check ROOT_DIR "/root"
${symlinkLine}
`;

    const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    assert.equal(res.status, 0, `Adaptive ProtectHome helper script failed:\n${res.stderr}`);
    assert.match(res.stdout, /^OPT=false$/m);
    assert.match(res.stdout, /^USR=false$/m);
    assert.match(res.stdout, /^ETC=false$/m);
    assert.match(res.stdout, /^HOME_SUB=true$/m);
    assert.match(res.stdout, /^ROOT_SUB=true$/m);
    assert.match(res.stdout, /^HOME_DIR=true$/m);
    assert.match(res.stdout, /^ROOT_DIR=true$/m);
    assert.match(res.stdout, /^SYMLINK=true$/m);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('deploy/quick-install.sh validates args/ports, preserves secrets, and detects cross-platform OS/distro & macOS LaunchAgent', { skip: !HAS_BASH }, () => {
  const helpRes = spawnSync('bash', [path.join(ROOT, 'deploy/quick-install.sh'), '--help'], { encoding: 'utf8' });
  assert.equal(helpRes.status, 0, `quick-install.sh --help failed:\n${helpRes.stderr}`);
  assert.match(helpRes.stdout, /--install-dir/);
  assert.match(helpRes.stdout, /--port/);
  assert.match(helpRes.stdout, /--host/);
  assert.match(helpRes.stdout, /--non-interactive/);
  assert.match(helpRes.stdout, /--skip-browser/);
  assert.match(helpRes.stdout, /--skip-service/);

  const badPortRes = spawnSync(
    'bash',
    [path.join(ROOT, 'deploy/quick-install.sh'), '--non-interactive', '--port=notaport'],
    { encoding: 'utf8' },
  );
  assert.notEqual(badPortRes.status, 0, 'quick-install.sh should reject non-numeric --port');

  const outOfRangePortRes = spawnSync(
    'bash',
    [path.join(ROOT, 'deploy/quick-install.sh'), '--non-interactive', '--port=70000'],
    { encoding: 'utf8' },
  );
  assert.notEqual(outOfRangePortRes.status, 0, 'quick-install.sh should reject out-of-range --port');

  const unknownArgRes = spawnSync(
    'bash',
    [path.join(ROOT, 'deploy/quick-install.sh'), '--no-such-flag'],
    { encoding: 'utf8' },
  );
  assert.notEqual(unknownArgRes.status, 0, 'quick-install.sh should reject unknown flags');

  const rawQuickInstall = readUtf8('deploy/quick-install.sh');

  // Verify supported package managers and environment detection branches exist
  for (const token of ['apt', 'dnf', 'yum', 'pacman', 'apk', 'zypper', 'brew']) {
    assert.ok(rawQuickInstall.includes(token), `quick-install.sh missing ${token} support`);
  }
  assert.match(rawQuickInstall, /com\.deepseek\.free-proxy\.plist/);
  assert.match(rawQuickInstall, /IS_WSL/);
  assert.match(rawQuickInstall, /IS_CONTAINER/);
  assert.match(rawQuickInstall, /SYSTEMD_ACTIVE/);

  const tmpDir = makeTempDir('deepseek-qi-test-');
  try {
    // 1. Test platform/distro/init detection preamble directly from quick-install.sh
    const marker = '# Resolve default INSTALL_DIR';
    const markerIdx = rawQuickInstall.indexOf(marker);
    assert.notEqual(markerIdx, -1, 'Expected Resolve default INSTALL_DIR section');
    const detectPrefix = rawQuickInstall.slice(0, markerIdx) + '\nreturn 0\n}\nmain "$@"\n';

    const osRelPath = path.join(tmpDir, 'mock-os-release');
    const detectScriptPath = path.join(tmpDir, 'qi-detect.sh');
    fs.writeFileSync(
      detectScriptPath,
      detectPrefix.replace(/\/etc\/os-release/g, osRelPath),
      'utf8',
    );

    const mockBinDir = path.join(tmpDir, 'mock-bins');
    fs.mkdirSync(mockBinDir, { recursive: true });
    for (const bin of ['apt-get', 'dnf', 'yum', 'pacman', 'apk', 'zypper', 'brew']) {
      const p = path.join(mockBinDir, bin);
      fs.writeFileSync(p, '#!/bin/sh\nexit 0\n', 'utf8');
      fs.chmodSync(p, 0o755);
    }

    // Check Windows shell rejection
    const winRes = spawnSync(
      'bash',
      ['-c', `uname() { echo "MINGW64_NT-10.0"; }; export -f uname; bash "${detectScriptPath}" --non-interactive`],
      { encoding: 'utf8' },
    );
    assert.notEqual(winRes.status, 0, 'Windows MSYS/MINGW shell should exit non-zero with guidance');
    assert.match(winRes.stderr, /Windows shell/i);

    // Check macOS detection
    const macRes = spawnSync(
      'bash',
      ['-c', `uname() { echo "Darwin"; }; export -f uname; PATH="${mockBinDir}:/usr/bin:/bin" bash "${detectScriptPath}" --non-interactive --port=9888`],
      { encoding: 'utf8' },
    );
    assert.equal(macRes.status, 0, `macOS detection failed:\n${macRes.stderr}`);
    assert.match(macRes.stdout, /Platform: Darwin \(darwin, pkg=brew/);

    // Check Linux distro family -> package manager detection matrix
    const distroCases = [
      { id: 'debian', idLike: '', pkg: 'apt' },
      { id: 'ubuntu', idLike: 'debian', pkg: 'apt' },
      { id: 'fedora', idLike: '', pkg: 'dnf' },
      { id: 'rocky', idLike: 'rhel centos fedora', pkg: 'dnf' },
      { id: 'arch', idLike: '', pkg: 'pacman' },
      { id: 'alpine', idLike: '', pkg: 'apk' },
      { id: 'opensuse-tumbleweed', idLike: 'opensuse suse', pkg: 'zypper' },
    ];

    for (const tc of distroCases) {
      fs.writeFileSync(osRelPath, `ID="${tc.id}"\nID_LIKE="${tc.idLike}"\n`, 'utf8');
      const dRes = spawnSync(
        'bash',
        [
          '-c',
          `uname() { echo "Linux"; }; export -f uname; PATH="${mockBinDir}:/usr/bin:/bin" bash "${detectScriptPath}" --non-interactive`,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(dRes.status, 0, `Distro probe failed for ${tc.id}:\n${dRes.stderr}`);
      assert.match(dRes.stdout, new RegExp(`distro=${tc.id}, pkg=${tc.pkg}\\b`), `Output for ${tc.id}: ${dRes.stdout}`);
    }

    // 2. Test ensure_local_env_and_auth + setup_macos_launchagent helper functions safely
    const envFn = extractBashFunction(rawQuickInstall, 'ensure_local_env_and_auth');
    const macFn = extractBashFunction(rawQuickInstall, 'setup_macos_launchagent');

    const fakeInstallDir = path.join(tmpDir, 'install-target');
    const fakeHome = path.join(tmpDir, 'mac-home');
    fs.mkdirSync(fakeInstallDir, { recursive: true });
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.writeFileSync(path.join(fakeInstallDir, '.env.example'), 'HOST=127.0.0.1\nPORT=9655\nPROXY_API_KEY=\n', 'utf8');

    const macToolsDir = path.join(tmpDir, 'mac-tools');
    fs.mkdirSync(macToolsDir, { recursive: true });
    fs.writeFileSync(path.join(macToolsDir, 'launchctl'), '#!/bin/sh\nexit 0\n', 'utf8');
    fs.chmodSync(path.join(macToolsDir, 'launchctl'), 0o755);
    fs.writeFileSync(path.join(macToolsDir, 'curl'), '#!/bin/sh\nexit 0\n', 'utf8');
    fs.chmodSync(path.join(macToolsDir, 'curl'), 0o755);

    const helperRunner = `
set -euo pipefail
log_info() { echo "INFO:$*"; }
log_ok() { echo "OK:$*"; }
log_warn() { echo "WARN:$*"; }
INSTALL_DIR="${fakeInstallDir}"
HOME="${fakeHome}"
HOST="0.0.0.0"
PORT="9777"
NODE_BIN="${process.execPath}"
${envFn}
${macFn}
setup_macos_launchagent
`;
    const helperRes = spawnSync('bash', ['-c', helperRunner], {
      env: { ...process.env, PATH: `${macToolsDir}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    assert.equal(helperRes.status, 0, `Helper test failed:\n${helperRes.stderr}\n${helperRes.stdout}`);
    assert.match(helperRes.stdout, /macOS LaunchAgent loaded and healthy at http:\/\/127\.0\.0\.1:9777\/health/);

    const createdEnv = fs.readFileSync(path.join(fakeInstallDir, '.env'), 'utf8');
    assert.match(createdEnv, /^HOST="0\.0\.0\.0"$/m);
    assert.match(createdEnv, /^PORT="9777"$/m);
    assert.match(createdEnv, /^PROXY_API_KEY="sk-deepseek-[0-9a-f]{32}"$/m);
    assert.equal(fs.statSync(path.join(fakeInstallDir, '.env')).mode & 0o777, 0o600);

    const createdAuth = fs.readFileSync(path.join(fakeInstallDir, 'deepseek-auth.json'), 'utf8');
    assert.deepEqual(JSON.parse(createdAuth), {});
    assert.equal(fs.statSync(path.join(fakeInstallDir, 'deepseek-auth.json')).mode & 0o777, 0o600);

    const plistPath = path.join(fakeHome, 'Library', 'LaunchAgents', 'com.deepseek.free-proxy.plist');
    const plist = fs.readFileSync(plistPath, 'utf8');
    assert.match(plist, /<string>com\.deepseek\.free-proxy<\/string>/);
    assert.match(plist, new RegExp(`<string>${fakeInstallDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/server\\.js</string>`));
    assert.match(plist, /<key>PORT<\/key>\s*<string>9777<\/string>/);

    // Re-running ensure_local_env_and_auth must preserve populated .env and deepseek-auth.json
    fs.writeFileSync(path.join(fakeInstallDir, '.env'), 'PROXY_API_KEY="keep-me"\n', { mode: 0o600 });
    fs.writeFileSync(path.join(fakeInstallDir, 'deepseek-auth.json'), '{"token":"keep-tok"}\n', { mode: 0o600 });
    const preserveRes = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
log_info() { echo "INFO:$*"; }
log_ok() { echo "OK:$*"; }
INSTALL_DIR="${fakeInstallDir}"
HOST="127.0.0.1"
PORT="9655"
${envFn}
ensure_local_env_and_auth`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(preserveRes.status, 0, preserveRes.stderr);
    assert.equal(fs.readFileSync(path.join(fakeInstallDir, '.env'), 'utf8'), 'PROXY_API_KEY="keep-me"\n');
    assert.equal(fs.readFileSync(path.join(fakeInstallDir, 'deepseek-auth.json'), 'utf8'), '{"token":"keep-tok"}\n');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runtime JS codebase avoids Node 20+ AbortSignal.any (preserves engines.node >= 18.0.0)', () => {
  const files = [
    'server.js',
    'cli.js',
    'client.js',
    ...listJsFiles('lib'),
    ...listJsFiles('src'),
    ...listJsFiles('scripts'),
  ];

  assert.ok(files.length >= 10, 'Expected runtime JS files to be enumerated');
  for (const rel of files) {
    const content = readUtf8(rel);
    assert.doesNotMatch(content, /\bAbortSignal\.any\s*\(/, `${rel} must not use AbortSignal.any (unsupported on Node 18)`);
  }
});

test('doctor.js and ensure_browser.js provide cross-platform host formatting, systemd checks, and safe browser lookup', () => {
  const { formatProbeHost } = require('../scripts/doctor');
  const { findSystemExecutable, resolveChromePath } = require('../scripts/ensure_browser');

  assert.equal(formatProbeHost(''), '127.0.0.1');
  assert.equal(formatProbeHost('0.0.0.0'), '127.0.0.1');
  assert.equal(formatProbeHost('*'), '127.0.0.1');
  assert.equal(formatProbeHost('::'), '[::1]');
  assert.equal(formatProbeHost('[::]'), '[::1]');
  assert.equal(formatProbeHost('::1'), '[::1]');
  assert.equal(formatProbeHost('[::1]'), '[::1]');
  assert.equal(formatProbeHost('127.0.0.1'), '127.0.0.1');

  const sysCheck = spawnSync(
    process.execPath,
    ['-e', "const { isSystemdAvailable } = require('./scripts/doctor'); console.log(JSON.stringify(isSystemdAvailable()));"],
    { cwd: ROOT, env: { ...process.env, PATH: '' }, encoding: 'utf8' },
  );
  assert.equal(sysCheck.status, 0, sysCheck.stderr);
  assert.equal(sysCheck.stdout.trim(), 'false');

  const tmpDir = makeTempDir('deepseek-browser-test-');
  const prevEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CHROME_PATH: process.env.CHROME_PATH,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
  };

  try {
    const dir1 = path.join(tmpDir, 'bin1');
    const dir2 = path.join(tmpDir, 'bin2');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    const nonExec = path.join(dir1, 'fake-chrome');
    const realExec = path.join(dir2, 'fake-chrome');
    fs.writeFileSync(nonExec, '#!/bin/sh\n', 'utf8');
    fs.writeFileSync(realExec, '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') {
      fs.chmodSync(nonExec, 0o644);
      fs.chmodSync(realExec, 0o755);
    }

    process.env.PATH = `${dir1}${path.delimiter}${dir2}`;
    if (process.platform !== 'win32') {
      assert.equal(findSystemExecutable('fake-chrome'), realExec);
    } else {
      assert.ok(findSystemExecutable('fake-chrome'));
    }
    assert.equal(findSystemExecutable('nonexistent;echo hi'), '');

    const pwDir = path.join(tmpDir, 'pw-browsers');
    const binRel = process.platform === 'darwin'
      ? path.join('chromium-1140', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
      : process.platform === 'win32'
        ? path.join('chromium-1140', 'chrome-win64', 'chrome.exe')
        : path.join('chromium-1140', 'chrome-linux64', 'chrome');
    const expectedChrome = path.join(pwDir, binRel);
    fs.mkdirSync(path.dirname(expectedChrome), { recursive: true });
    fs.writeFileSync(expectedChrome, 'stub', 'utf8');

    process.env.HOME = '';
    process.env.CHROME_PATH = '';
    process.env.XDG_CACHE_HOME = '';
    process.env.PLAYWRIGHT_BROWSERS_PATH = pwDir;

    assert.equal(resolveChromePath(), expectedChrome);
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('setup_wizard.js preserves API key semantics and writes 0600 sanitized .env files cleanly', () => {
  const tmpDir = makeTempDir('deepseek-wizard-test-');
  try {
    const envPath = path.join(tmpDir, '.env');
    fs.writeFileSync(envPath, 'CUSTOM_KEEP="yes"\nPROXY_API_KEY="existing-secret"\n', 'utf8');

    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `
const assert = require('node:assert/strict');
const fs = require('fs');
const { parseArgs, updateEnvFile } = require('./scripts/setup_wizard');

const pDefault = parseArgs(['--non-interactive', '--port=9777']);
assert.equal(pDefault.nonInteractive, true);
assert.equal(pDefault.port, '9777');
assert.equal(pDefault.apiKey, undefined);

const pCleared = parseArgs(['--api-key=']);
assert.equal(pCleared.apiKey, '');

const target = ${JSON.stringify(envPath)};
updateEnvFile(target, { PORT: '9777', HOST: '127.0.0.1', PROXY_API_KEY: 'new-"key"$1' });
const written = fs.readFileSync(target, 'utf8');
assert.match(written, /^CUSTOM_KEEP="yes"$/m);
assert.match(written, /^PORT="9777"$/m);
assert.match(written, /^PROXY_API_KEY="new-\\\\"key\\\\"\\$1"$/m);
if (process.platform !== 'win32') {
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
}
assert.throws(() => updateEnvFile(target, { PORT: '9655\\nEVIL=1' }), /newline/i);
`,
      ],
      {
        cwd: ROOT,
        env: { ...process.env, PROXY_API_KEY: 'test-placeholder' },
        encoding: 'utf8',
      },
    );
    assert.equal(child.status, 0, `setup_wizard test failed:\n${child.stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('cli.js handles --help and inactive/missing systemd gracefully', () => {
  const helpRes = spawnSync(process.execPath, [path.join(ROOT, 'cli.js'), '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(helpRes.status, 0, helpRes.stderr);
  assert.match(helpRes.stdout, /FreeDeepseekAPI/i);

  const svcRes = spawnSync(process.execPath, [path.join(ROOT, 'cli.js'), 'service', 'status'], {
    cwd: ROOT,
    env: { ...process.env, PATH: '' },
    encoding: 'utf8',
  });
  assert.equal(svcRes.status, 1);
  assert.match(svcRes.stdout, /systemd|Linux only/i);
});
