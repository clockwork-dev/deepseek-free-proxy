#!/usr/bin/env node
'use strict';

/**
 * FreeDeepseekAPI Unified CLI Entrypoint & Interactive TUI
 * Provides service management, one-click authentication,
 * token validation, diagnostics, and setup wizard.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync, execFileSync } = require('child_process');

const { loadDotEnv } = require('./lib/env');
const { defaultAuthOutputPath } = require('./scripts/auth_import');
const { resolveChromePath, findSystemExecutable } = require('./scripts/ensure_browser');
const { runDoctor, printReport, checkAuthFile, authPaths, isSystemdAvailable, formatProbeHost } = require('./scripts/doctor');
const { runSetupWizard } = require('./scripts/setup_wizard');

const ROOT = __dirname;
loadDotEnv(path.join(ROOT, '.env'));

const pkg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); }
  catch { return { version: '0.1.0' }; }
})();

// Styling helper
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && !process.argv.includes('--no-color');
const c = {
  reset: useColor ? '\x1b[0m' : '',
  bold: useColor ? '\x1b[1m' : '',
  dim: useColor ? '\x1b[2m' : '',
  green: useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  red: useColor ? '\x1b[31m' : '',
  cyan: useColor ? '\x1b[36m' : '',
  blue: useColor ? '\x1b[34m' : '',
  magenta: useColor ? '\x1b[35m' : '',
  white: useColor ? '\x1b[37m' : '',
};

function clearScreen() {
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[2J\x1b[0f');
  }
}

function prompt(rl, question) {
  return new Promise(resolve => {
    rl.question(question, ans => resolve(ans.trim()));
  });
}

function waitForEnter(rl, message = 'Press Enter to continue...') {
  return new Promise(resolve => {
    rl.question(`\n${c.dim}${message}${c.reset}`, () => resolve());
  });
}

function runCommandWithSudo(cmd, args, opts = {}) {
  const isRoot = typeof process.getuid === 'function' ? process.getuid() === 0 : false;
  if (isRoot || process.platform === 'win32') {
    const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
    if (res.error) console.error(`${c.red}Failed to run ${cmd}: ${res.error.message}${c.reset}`);
    return { ...res, status: res.status ?? 1 };
  }
  if (!findSystemExecutable('sudo')) {
    console.error(`${c.red}sudo is not installed and current user is not root. Run as root: ${cmd} ${args.join(' ')}${c.reset}`);
    return { status: 1 };
  }
  console.log(`${c.dim}[sudo] Requesting elevated permissions for: ${cmd} ${args.join(' ')}${c.reset}`);
  const res = spawnSync('sudo', [cmd, ...args], { stdio: 'inherit', ...opts });
  if (res.error) console.error(`${c.red}Failed to run sudo ${cmd}: ${res.error.message}${c.reset}`);
  return { ...res, status: res.status ?? 1 };
}

// -------------------------------------------------------------------------
// Service Management
// -------------------------------------------------------------------------
function getServiceStatus() {
  if (process.platform === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.deepseek.free-proxy.plist');
    if (!fs.existsSync(plistPath)) {
      return { installed: false, active: false, statusText: 'N/A (Linux only; LaunchAgent not installed)' };
    }
    try {
      const uid = typeof process.getuid === 'function' ? process.getuid() : '';
      const out = execFileSync('launchctl', ['print', `gui/${uid}/com.deepseek.free-proxy`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const active = /state\s*=\s*running/i.test(out);
      return { installed: true, active, statusText: active ? 'active (LaunchAgent)' : 'inactive (LaunchAgent)' };
    } catch {
      return { installed: true, active: false, statusText: 'installed (LaunchAgent)' };
    }
  }
  if (process.platform !== 'linux') {
    return { installed: false, active: false, statusText: 'N/A (Linux only)' };
  }
  const unitPath = '/etc/systemd/system/free-deepseek-api.service';
  const installed = fs.existsSync(unitPath);
  if (!isSystemdAvailable()) {
    return { installed, active: false, statusText: 'systemd inactive (container/WSL)' };
  }
  if (!installed) {
    return { installed: false, active: false, statusText: 'Not installed' };
  }
  try {
    const res = spawnSync('systemctl', ['is-active', 'free-deepseek-api'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const statusText = (res.stdout || '').trim() || 'inactive';
    return {
      installed: true,
      active: statusText === 'active',
      statusText,
    };
  } catch {
    return { installed: true, active: false, statusText: 'unknown' };
  }
}

function handleServiceCommand(subcommand = 'status', args = []) {
  if (process.platform !== 'linux') {
    console.log(`${c.yellow}⚠️ Systemd service management is Linux only (current platform: ${process.platform}).${c.reset}`);
    if (process.platform === 'darwin') {
      console.log(`On macOS, manage the LaunchAgent (~/Library/LaunchAgents/com.deepseek.free-proxy.plist) or run '${c.bold}npm start${c.reset}'.`);
    }
    return 1;
  }

  const sub = subcommand.toLowerCase();
  const unitName = 'free-deepseek-api';
  const unitPath = '/etc/systemd/system/free-deepseek-api.service';

  if (!isSystemdAvailable() && sub !== 'uninstall') {
    console.log(`${c.yellow}⚠️ systemd is not active in this environment (container, WSL without systemd, or non-systemd distro).${c.reset}`);
    console.log(`Run the proxy in foreground instead: ${c.bold}NON_INTERACTIVE=1 npm start${c.reset}`);
    return 1;
  }

  switch (sub) {
    case 'status': {
      if (!fs.existsSync(unitPath)) {
        console.log(`${c.yellow}⚠️ free-deepseek-api.service is not installed.${c.reset}`);
        console.log(`To install, run: ${c.bold}npm run cli service install${c.reset} (or sudo ./deploy/install.sh)`);
        return 1;
      }
      console.log(`${c.bold}=== Systemd Service Status ===${c.reset}`);
      const res = spawnSync('systemctl', ['status', unitName, '--no-pager'], { stdio: 'inherit' });
      return res.status ?? 1;
    }
    case 'start': {
      if (!fs.existsSync(unitPath)) {
        console.log(`${c.red}✖ Service not installed. Run 'cli.js service install' first.${c.reset}`);
        return 1;
      }
      console.log(`Starting ${unitName}.service...`);
      const res = runCommandWithSudo('systemctl', ['start', unitName]);
      if (res.status === 0) {
        console.log(`${c.green}✔ Service started successfully.${c.reset}`);
      }
      return res.status;
    }
    case 'stop': {
      console.log(`Stopping ${unitName}.service...`);
      const res = runCommandWithSudo('systemctl', ['stop', unitName]);
      if (res.status === 0) {
        console.log(`${c.green}✔ Service stopped.${c.reset}`);
      }
      return res.status;
    }
    case 'restart': {
      console.log(`Restarting ${unitName}.service...`);
      const res = runCommandWithSudo('systemctl', ['restart', unitName]);
      if (res.status === 0) {
        console.log(`${c.green}✔ Service restarted successfully.${c.reset}`);
      }
      return res.status;
    }
    case 'logs': {
      if (!findSystemExecutable('journalctl')) {
        console.log(`${c.red}✖ journalctl is not available in this environment.${c.reset}`);
        return 1;
      }
      let lines = '50';
      const follow = args.includes('-f') || args.includes('--follow');
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith('--lines=')) lines = a.slice(8);
        else if (a === '--lines' && args[i + 1]) lines = args[++i];
        else if (a.startsWith('-n=')) lines = a.slice(3);
        else if (a === '-n' && args[i + 1]) lines = args[++i];
      }
      if (!/^\d+$/.test(lines)) lines = '50';
      const journalArgs = ['-u', unitName, '-n', lines];
      if (follow) journalArgs.push('-f');
      else journalArgs.push('--no-pager');

      console.log(`${c.bold}=== Service Logs (journalctl) ===${c.reset}`);
      const res = spawnSync('journalctl', journalArgs, { stdio: 'inherit' });
      return res.status ?? 1;
    }
    case 'install': {
      const installScript = path.join(ROOT, 'deploy', 'install.sh');
      console.log(`${c.bold}Installing free-deepseek-api.service...${c.reset}`);
      const hasExplicitUserOrDir = args.some(a =>
        a === '--current-user' ||
        a.startsWith('--service-user') ||
        a.startsWith('--install-dir')
      );
      const passArgs = hasExplicitUserOrDir ? args : ['--current-user', ...args];
      const res = runCommandWithSudo('bash', [installScript, ...passArgs]);
      return res.status;
    }
    case 'uninstall': {
      const uninstallScript = path.join(ROOT, 'deploy', 'uninstall.sh');
      console.log(`${c.bold}Uninstalling free-deepseek-api.service...${c.reset}`);
      const res = runCommandWithSudo('bash', [uninstallScript, ...args]);
      return res.status;
    }
    default: {
      console.log(`${c.red}Unknown service command: ${subcommand}${c.reset}`);
      console.log('Available service commands: status, start, stop, restart, logs, install, uninstall');
      return 1;
    }
  }
}

// -------------------------------------------------------------------------
// Auth Management & Token Validation
// -------------------------------------------------------------------------
function getAuthSummary() {
  const files = authPaths();
  let validCount = 0;
  let totalCount = files.length;
  let hasMissing = false;

  for (const f of files) {
    const res = checkAuthFile(f);
    if (res.ok) validCount++;
    else hasMissing = true;
  }

  if (validCount > 0 && !hasMissing) {
    return { valid: true, statusText: `${validCount} account(s) valid` };
  }
  if (validCount > 0 && hasMissing) {
    return { valid: true, statusText: `${validCount}/${totalCount} valid (some issues)` };
  }
  return { valid: false, statusText: 'Missing / Invalid' };
}

async function validateAccountTokens(runLive = false) {
  console.log(`\n${c.cyan}${c.bold}======================================================${c.reset}`);
  console.log(`${c.bold}       DeepSeek Account & Token Validation            ${c.reset}`);
  console.log(`${c.cyan}======================================================${c.reset}`);

  const files = authPaths();
  console.log(`Accounts source: ${process.env.DEEPSEEK_AUTH_DIR ? 'DEEPSEEK_AUTH_DIR' : 'DEEPSEEK_AUTH_PATH / default'}`);
  console.log(`Found ${files.length} account file(s) to inspect:\n`);

  let allValid = true;

  for (const file of files) {
    console.log(`${c.bold}📄 File:${c.reset} ${file}`);
    const res = checkAuthFile(file);

    if (!res.ok) {
      allValid = false;
      for (const issue of res.issues) {
        console.log(`  ${c.red}✖ ${issue}${c.reset}`);
      }
      if (!res.auth) {
        console.log(`  ${c.yellow}👉 Run 'npm run auth' or 'cli.js auth login' to update credentials.${c.reset}\n`);
        continue;
      }
    }

    // Auth file is present and parsed
    console.log(`  ${c.green}✔ JSON format: valid${c.reset}`);
    const auth = res.auth;

    // Token inspection
    if (auth.token) {
      const isHex = /^[0-9a-fA-F]{64}$/.test(auth.token);
      const maskedToken = auth.token.length > 12
        ? `${auth.token.slice(0, 6)}...${auth.token.slice(-6)} (${auth.token.length} chars)`
        : `${auth.token.slice(0, 2)}...`;

      console.log(`  ${c.green}✔ Token:${c.reset} ${maskedToken} [Format: ${isHex ? '64-hex' : 'token'}]`);

      if (res.metadata?.expiresAt) {
        const expDate = new Date(res.metadata.expiresAt);
        const isExpired = expDate < new Date();
        const color = isExpired ? c.red : c.green;
        console.log(`  ${color}Token Expiration:${c.reset} ${res.metadata.expiresAt} ${isExpired ? '(EXPIRED!)' : '(Valid)'}`);
        if (isExpired) allValid = false;
      }
    }

    // Cookie inspection
    if (auth.cookie) {
      const hasSession = auth.cookie.includes('ds_session_id');
      const hasSmid = auth.cookie.includes('smidV2');
      console.log(`  ${c.green}✔ Cookies:${c.reset} Present (${auth.cookie.length} chars)`);
      console.log(`    - ds_session_id: ${hasSession ? c.green + '✔' : c.red + '✖ Missing'}${c.reset}`);
      console.log(`    - smidV2:        ${hasSmid ? c.green + '✔' : c.dim + 'optional'}${c.reset}`);
    }

    // WASM URL
    if (auth.wasmUrl) {
      console.log(`  ${c.green}✔ WASM Solver URL:${c.reset} ${auth.wasmUrl}`);
    }

    // File permissions
    if (process.platform === 'win32') {
      console.log(`  ${c.dim}Permissions: Windows ACL${c.reset}`);
    } else {
      try {
        const mode = fs.statSync(file).mode & 0o777;
        const modeStr = mode.toString(8);
        if ((mode & 0o077) === 0) {
          console.log(`  ${c.green}✔ Permissions: ${modeStr} (owner-only secure)${c.reset}`);
        } else {
          console.log(`  ${c.yellow}⚠️ Permissions: ${modeStr} (recommended: chmod 600 ${file})${c.reset}`);
        }
      } catch {}
    }

    // Live validation if requested
    if (runLive && auth) {
      process.stdout.write('  Connecting to chat.deepseek.com to verify session... ');
      try {
        const base = String(process.env.DEEPSEEK_BASE_URL || 'https://chat.deepseek.com').replace(/\/+$/, '');
        const startTime = Date.now();
        const r = await fetch(`${base}/api/v0/chat/create_pow_challenge`, {
          method: 'POST',
          headers: {
            'User-Agent': 'Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36',
            'x-client-platform': 'web',
            'x-client-version': '2.0.0',
            'Authorization': `Bearer ${auth.token || ''}`,
            'Origin': 'https://chat.deepseek.com',
            'Referer': 'https://chat.deepseek.com/',
            'Cookie': auth.cookie || '',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
          signal: AbortSignal.timeout(10000),
        });
        const elapsed = Date.now() - startTime;
        const text = await r.text();
        let challenge = null;
        try { challenge = JSON.parse(text)?.data?.biz_data?.challenge || null; } catch {}

        if (r.ok && challenge) {
          console.log(`${c.green}ACTIVE & VERIFIED!${c.reset} (${elapsed}ms, challenge received)`);
        } else {
          allValid = false;
          console.log(`${c.red}FAILED (HTTP ${r.status})${c.reset}`);
          console.log(`    Response: ${text.substring(0, 150)}`);
          console.log(`    ${c.yellow}The token may have expired or DeepSeek requires re-login.${c.reset}`);
        }
      } catch (e) {
        allValid = false;
        console.log(`${c.red}NETWORK ERROR: ${e.message}${c.reset}`);
      }
    }
    console.log('');
  }

  console.log(`${c.cyan}======================================================${c.reset}`);
  return allValid ? 0 : 1;
}

async function handleAuthCommand(subcommand = 'status', args = []) {
  const sub = subcommand.toLowerCase();
  switch (sub) {
    case 'login':
    case 'capture':
    case 'add': {
      console.log(`${c.bold}Launching DeepSeek Web login helper...${c.reset}`);
      const script = path.join(ROOT, 'scripts', 'deepseek_chrome_auth.js');
      const res = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', env: process.env });
      return res.status ?? 1;
    }
    case 'import': {
      console.log(`${c.bold}Launching credentials import wizard...${c.reset}`);
      const script = path.join(ROOT, 'scripts', 'auth_import.js');
      const res = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', env: process.env });
      return res.status ?? 1;
    }
    case 'status':
    case 'validate':
    case 'check': {
      const live = args.includes('--live') || args.includes('-l');
      return await validateAccountTokens(live);
    }
    case 'remove': {
      const defaultPath = defaultAuthOutputPath(process.env, ROOT);
      if (fs.existsSync(defaultPath)) {
        fs.rmSync(defaultPath, { force: true });
        console.log(`${c.green}✔ Removed auth file: ${defaultPath}${c.reset}`);
      } else {
        console.log(`${c.yellow}Auth file does not exist: ${defaultPath}${c.reset}`);
      }
      return 0;
    }
    default: {
      console.log(`${c.red}Unknown auth command: ${subcommand}${c.reset}`);
      console.log('Available auth commands: login, import, status, validate, remove');
      return 1;
    }
  }
}

// -------------------------------------------------------------------------
// Local Proxy Health & Ping
// -------------------------------------------------------------------------
async function checkProxyHealth() {
  const port = process.env.PORT || 9655;
  const host = process.env.HOST || '127.0.0.1';
  const probeHost = formatProbeHost(host);
  let apiKey = process.env.PROXY_API_KEY || '';
  if (!apiKey && process.env.PROXY_API_KEY_FILE) {
    try { apiKey = fs.readFileSync(process.env.PROXY_API_KEY_FILE, 'utf8').trim(); } catch {}
  }

  console.log(`Checking local proxy health at http://${probeHost}:${port}...`);
  const headers = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const start = Date.now();
  let modelsData = null;

  try {
    const res = await fetch(`http://${probeHost}:${port}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    const latency = Date.now() - start;

    if (res.ok) {
      try { modelsData = await res.json(); } catch {}
      console.log(`${c.green}✔ Proxy is healthy and responding!${c.reset} (${latency}ms)`);
      console.log(`  Endpoint: http://${probeHost}:${port}`);
      if (modelsData?.data && Array.isArray(modelsData.data)) {
        const modelNames = modelsData.data.map(m => m.id).join(', ');
        console.log(`  Available models: ${c.bold}${modelNames}${c.reset}`);
      }
      return 0;
    } else {
      console.log(`${c.yellow}⚠️ Proxy responded with HTTP ${res.status}: ${res.statusText}${c.reset}`);
      return 1;
    }
  } catch (e) {
    console.log(`${c.red}✖ Proxy is not reachable at http://${probeHost}:${port} (${e.message})${c.reset}`);
    console.log(`  To start proxy in foreground: ${c.bold}npm start${c.reset}`);
    if (process.platform === 'linux' && isSystemdAvailable()) {
      console.log(`  To start background service:   ${c.bold}npm run cli service start${c.reset}`);
    }
    return 1;
  }
}

// -------------------------------------------------------------------------
// Interactive Service Manager Submenu
// -------------------------------------------------------------------------
async function serviceMenu(rl) {
  while (true) {
    clearScreen();
    const svc = getServiceStatus();
    const svcColor = svc.active ? c.green : (svc.installed ? c.yellow : c.dim);

    console.log(`${c.cyan}${c.bold}╔════════════════════════════════════════════════════════════╗${c.reset}`);
    console.log(`${c.cyan}${c.bold}║               Systemd Service Manager                      ║${c.reset}`);
    console.log(`${c.cyan}${c.bold}╚════════════════════════════════════════════════════════════╝${c.reset}`);
    console.log(`Status: ${svcColor}${c.bold}${svc.statusText}${c.reset}\n`);

    console.log(`  ${c.bold}1${c.reset} - 📊 View Service Status (systemctl status)`);
    console.log(`  ${c.bold}2${c.reset} - 📜 View Service Logs (journalctl -n 50)`);
    console.log(`  ${c.bold}3${c.reset} - ▶️  Start Service`);
    console.log(`  ${c.bold}4${c.reset} - ⏹  Stop Service`);
    console.log(`  ${c.bold}5${c.reset} - 🔄 Restart Service`);
    console.log(`  ${c.bold}6${c.reset} - 🛠  Install Service (sudo ./deploy/install.sh)`);
    console.log(`  ${c.bold}7${c.reset} - 🗑  Uninstall Service (sudo ./deploy/uninstall.sh)`);
    console.log(`  ${c.bold}0${c.reset} - 🔙 Back to Main Menu`);

    const choice = await prompt(rl, `\n${c.bold}Select option [0-7]:${c.reset} `);

    if (choice === '1') {
      handleServiceCommand('status');
      await waitForEnter(rl);
    } else if (choice === '2') {
      handleServiceCommand('logs');
      await waitForEnter(rl);
    } else if (choice === '3') {
      handleServiceCommand('start');
      await waitForEnter(rl);
    } else if (choice === '4') {
      handleServiceCommand('stop');
      await waitForEnter(rl);
    } else if (choice === '5') {
      handleServiceCommand('restart');
      await waitForEnter(rl);
    } else if (choice === '6') {
      handleServiceCommand('install');
      await waitForEnter(rl);
    } else if (choice === '7') {
      handleServiceCommand('uninstall');
      await waitForEnter(rl);
    } else if (choice === '0' || choice === 'q') {
      break;
    }
  }
}

// -------------------------------------------------------------------------
// Main Interactive TUI Menu
// -------------------------------------------------------------------------
async function interactiveMenu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    while (true) {
      clearScreen();
      const svc = getServiceStatus();
      const auth = getAuthSummary();
      const browser = resolveChromePath();
      const port = process.env.PORT || 9655;
      const host = process.env.HOST || '127.0.0.1';

      const svcBadge = svc.active
        ? `${c.green}● active (running)${c.reset}`
        : (svc.installed ? `${c.yellow}○ inactive${c.reset}` : `${c.dim}not installed${c.reset}`);

      const authBadge = auth.valid
        ? `${c.green}✔ ${auth.statusText}${c.reset}`
        : `${c.red}✖ ${auth.statusText}${c.reset}`;

      const browserBadge = browser
        ? `${c.green}✔ Ready${c.reset}`
        : `${c.yellow}⚠️ Not found${c.reset}`;

      console.log(`${c.cyan}${c.bold}╔══════════════════════════════════════════════════════════════════╗${c.reset}`);
      console.log(`${c.cyan}${c.bold}║                 Free DeepSeek Proxy CLI v${pkg.version.padEnd(8)}                ║${c.reset}`);
      console.log(`${c.cyan}${c.bold}║            Local OpenAI-Compatible DeepSeek Gateway              ║${c.reset}`);
      console.log(`${c.cyan}${c.bold}╚══════════════════════════════════════════════════════════════════╝${c.reset}`);

      console.log(`${c.bold}System Status:${c.reset}`);
      console.log(`  Service:     ${svcBadge}`);
      console.log(`  Auth:        ${authBadge}`);
      console.log(`  Browser:     ${browserBadge}`);
      console.log(`  Gateway:     ${c.dim}http://${host}:${port}${c.reset}`);
      console.log(`${c.cyan}------------------------------------------------------------------${c.reset}`);

      console.log(`  ${c.bold}1${c.reset} - 🩺 Run Doctor Diagnostics (full health check)`);
      console.log(`  ${c.bold}2${c.reset} - 🔑 DeepSeek Web Login / Auth Capture (One-click)`);
      console.log(`  ${c.bold}3${c.reset} - 📋 Validate & Inspect Account Tokens`);
      console.log(`  ${c.bold}4${c.reset} - ⚙️  Systemd Service Manager (status / logs / restart)`);
      console.log(`  ${c.bold}5${c.reset} - 🚀 Run Interactive Setup Wizard`);
      console.log(`  ${c.bold}6${c.reset} - 💬 Test Chat / Quick Prompt`);
      console.log(`  ${c.bold}7${c.reset} - 🌐 Ping / Check Local Proxy Health`);
      console.log(`  ${c.bold}8${c.reset} - ▶️  Start Proxy in Foreground`);
      console.log(`  ${c.bold}0${c.reset} - 🚪 Exit`);

      const choice = await prompt(rl, `\n${c.bold}Select option [0-8]:${c.reset} `);

      if (choice === '1') {
        const report = await runDoctor({ offline: false });
        printReport(report, { offline: false });
        await waitForEnter(rl);
      } else if (choice === '2') {
        handleAuthCommand('login');
        await waitForEnter(rl);
      } else if (choice === '3') {
        await validateAccountTokens(true);
        await waitForEnter(rl);
      } else if (choice === '4') {
        await serviceMenu(rl);
      } else if (choice === '5') {
        await runSetupWizard({ nonInteractive: false });
        await waitForEnter(rl);
      } else if (choice === '6') {
        const testPrompt = await prompt(rl, 'Enter prompt to send to DeepSeek (or Enter to cancel): ');
        if (testPrompt) {
          const clientScript = path.join(ROOT, 'client.js');
          spawnSync(process.execPath, [clientScript, testPrompt], { stdio: 'inherit', env: process.env });
        }
        await waitForEnter(rl);
      } else if (choice === '7') {
        await checkProxyHealth();
        await waitForEnter(rl);
      } else if (choice === '8') {
        console.log(`${c.bold}Starting proxy server in foreground (Ctrl+C to stop)...${c.reset}`);
        const serverScript = path.join(ROOT, 'server.js');
        spawnSync(process.execPath, [serverScript], { stdio: 'inherit', env: process.env });
        await waitForEnter(rl);
      } else if (choice === '0' || choice === 'q' || choice === 'exit') {
        console.log(`\n${c.green}Goodbye!${c.reset}`);
        break;
      }
    }
  } finally {
    rl.close();
  }
}

// -------------------------------------------------------------------------
// CLI Help
// -------------------------------------------------------------------------
function printHelp() {
  console.log(`${c.bold}${c.cyan}FreeDeepseekAPI CLI${c.reset} v${pkg.version}
OpenAI-compatible local gateway for DeepSeek Web chat.

${c.bold}Usage:${c.reset}
  npm run cli                       Launch interactive TUI menu
  ./cli.js [command] [options]

${c.bold}Commands:${c.reset}
  ${c.bold}menu${c.reset}                          Open interactive console menu
  ${c.bold}doctor${c.reset} [--offline] [--json]   Run system diagnostics
  ${c.bold}setup${c.reset} [options]                 Run setup wizard (--non-interactive, etc.)
  ${c.bold}auth${c.reset} <subcommand>               Manage DeepSeek credentials:
                                    login    - Open browser to capture login credentials
                                    import   - Import credentials or cookies from file
                                    status   - Inspect credentials and validity
                                    validate - Test credentials with live challenge
                                    remove   - Remove local auth credentials
  ${c.bold}service${c.reset} <subcommand>            Manage Linux systemd background service:
                                    status   - Show service status
                                    start    - Start systemd service
                                    stop     - Stop systemd service
                                    restart  - Restart systemd service
                                    logs     - Show recent logs (journalctl)
                                    install  - Install systemd service unit
                                    uninstall- Remove systemd service unit
  ${c.bold}health${c.reset} | ${c.bold}ping${c.reset}                 Check local proxy server health
  ${c.bold}chat${c.reset} [prompt]                 Send quick query via client.js
  ${c.bold}start${c.reset}                          Run proxy server in foreground

${c.bold}General Options:${c.reset}
  --help, -h                    Show this help message
  --version, -v                 Show version
  --no-color                    Disable ANSI terminal coloring

${c.bold}Examples:${c.reset}
  npm run cli
  ./cli.js doctor --offline
  ./cli.js auth login
  ./cli.js service status
  ./cli.js service logs -f
  ./cli.js chat "Hello, DeepSeek!"
`);
}

// -------------------------------------------------------------------------
// Entrypoint dispatcher
// -------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const command = (args[0] || '').toLowerCase();

  if (args.length === 0) {
    if (process.stdout.isTTY) {
      return await interactiveMenu();
    } else {
      printHelp();
      return 0;
    }
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return 0;
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(`v${pkg.version}`);
    return 0;
  }

  if (command === 'menu') {
    return await interactiveMenu();
  }

  if (command === 'doctor') {
    const doctorScript = path.join(ROOT, 'scripts', 'doctor.js');
    const res = spawnSync(process.execPath, [doctorScript, ...args.slice(1)], { stdio: 'inherit', env: process.env });
    return res.status ?? 1;
  }

  if (command === 'setup') {
    const setupScript = path.join(ROOT, 'scripts', 'setup_wizard.js');
    const res = spawnSync(process.execPath, [setupScript, ...args.slice(1)], { stdio: 'inherit', env: process.env });
    return res.status ?? 1;
  }

  if (command === 'service') {
    const sub = args[1] || 'status';
    return handleServiceCommand(sub, args.slice(2));
  }

  if (command === 'auth' || command === 'login') {
    const sub = command === 'login' ? 'login' : (args[1] || 'status');
    const authArgs = command === 'login' ? args.slice(1) : args.slice(2);
    return await handleAuthCommand(sub, authArgs);
  }

  if (command === 'health' || command === 'ping') {
    return await checkProxyHealth();
  }

  if (command === 'chat' || command === 'ask') {
    const clientScript = path.join(ROOT, 'client.js');
    const chatArgs = args.slice(1);
    const res = spawnSync(process.execPath, [clientScript, ...chatArgs], { stdio: 'inherit', env: process.env });
    return res.status ?? 1;
  }

  if (command === 'start') {
    const serverScript = path.join(ROOT, 'server.js');
    const res = spawnSync(process.execPath, [serverScript, ...args.slice(1)], { stdio: 'inherit', env: process.env });
    return res.status ?? 1;
  }

  console.log(`${c.red}Unknown command: ${command}${c.reset}`);
  printHelp();
  return 1;
}

if (require.main === module) {
  main()
    .then(code => process.exit(code || 0))
    .catch(e => {
      console.error('[cli] ERROR:', e.message);
      process.exit(1);
    });
}

module.exports = {
  interactiveMenu,
  handleServiceCommand,
  handleAuthCommand,
  validateAccountTokens,
  checkProxyHealth,
  printHelp,
  getServiceStatus,
  getAuthSummary,
};
