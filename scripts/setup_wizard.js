#!/usr/bin/env node
'use strict';

/**
 * FreeDeepseekAPI Interactive Setup Wizard
 * Guides the user through initial configuration (port, proxy API key,
 * auto-installing browser, DeepSeek auth, and installing Linux systemd unit).
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { loadDotEnv } = require('../lib/env');
const { defaultAuthOutputPath } = require('./auth_import');
const { resolveChromePath, ensureBrowser } = require('./ensure_browser');
const { runDoctor, printReport, isSystemdAvailable, formatProbeHost } = require('./doctor');

const ROOT = path.resolve(__dirname, '..');
loadDotEnv(path.join(ROOT, '.env'));

// Styling
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
};

function banner() {
  console.log(`${c.cyan}${c.bold}======================================================${c.reset}`);
  console.log(`${c.bold}     FreeDeepseekAPI - Interactive Setup Wizard       ${c.reset}`);
  console.log(`${c.cyan}======================================================${c.reset}`);
  console.log('This wizard will guide you through:');
  console.log('  1. Network and security settings (.env)');
  console.log('  2. Browser engine for DeepSeek authentication');
  console.log('  3. DeepSeek Web account credentials capture');
  console.log('  4. Background service installation (Linux systemd)');
  console.log('  5. Diagnostic health check');
  console.log(`${c.cyan}------------------------------------------------------${c.reset}\n`);
}

function ask(rl, question, defaultValue = '') {
  const promptText = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  return new Promise(resolve => {
    let answered = false;
    rl.question(promptText, ans => {
      answered = true;
      const val = ans.trim();
      resolve(val || defaultValue);
    });
    rl.once('close', () => {
      if (!answered) resolve(defaultValue);
    });
  });
}

function askYesNo(rl, question, defaultYes = true) {
  const defaultLabel = defaultYes ? 'Y/n' : 'y/N';
  return new Promise(resolve => {
    let answered = false;
    rl.question(`${question} [${defaultLabel}]: `, ans => {
      answered = true;
      const val = ans.trim().toLowerCase();
      if (!val) return resolve(defaultYes);
      if (val === 'y' || val === 'yes' || val === '1' || val === 'true') return resolve(true);
      if (val === 'n' || val === 'no' || val === '0' || val === 'false') return resolve(false);
      return resolve(defaultYes);
    });
    rl.once('close', () => {
      if (!answered) resolve(defaultYes);
    });
  });
}

function sanitizeEnvValue(val) {
  const s = String(val);
  if (/[\r\n\0]/.test(s)) {
    throw new Error('Environment variable values must not contain newline or NUL characters.');
  }
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function updateEnvFile(envPath, updates) {
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  } else {
    const examplePath = path.join(path.dirname(envPath), '.env.example');
    if (fs.existsSync(examplePath)) {
      content = fs.readFileSync(examplePath, 'utf8');
    }
  }

  for (const [key, val] of Object.entries(updates)) {
    if (val === undefined || val === null) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable key: ${key}`);
    }
    const regex = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, 'm');
    const escaped = sanitizeEnvValue(val);
    const newLine = `${key}="${escaped}"`;
    if (regex.test(content)) {
      content = content.replace(regex, () => newLine);
    } else {
      content = (content ? content.trimEnd() + '\n' : '') + `${newLine}\n`;
    }
  }

  fs.writeFileSync(envPath, content, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(envPath, 0o600); } catch {}
  }
}

function hasPopulatedAuth(file) {
  try {
    if (!fs.existsSync(file)) return false;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Boolean(parsed && typeof parsed === 'object' && parsed.token && parsed.cookie);
  } catch {
    return false;
  }
}

function parseArgs(args = process.argv.slice(2)) {
  const options = {
    nonInteractive: false,
    port: '',
    host: '',
    apiKey: undefined,
    installBrowser: false,
    skipBrowser: false,
    installService: false,
    skipService: false,
    offline: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--non-interactive' || a === '-y') options.nonInteractive = true;
    else if (a === '--offline') options.offline = true;
    else if (a === '--install-browser') options.installBrowser = true;
    else if (a === '--skip-browser') options.skipBrowser = true;
    else if (a === '--install-service') options.installService = true;
    else if (a === '--skip-service') options.skipService = true;
    else if (a.startsWith('--port=')) options.port = a.slice(7);
    else if (a === '--port' && args[i + 1] !== undefined) options.port = args[++i];
    else if (a.startsWith('--host=')) options.host = a.slice(7);
    else if (a === '--host' && args[i + 1] !== undefined) options.host = args[++i];
    else if (a.startsWith('--api-key=')) options.apiKey = a.slice(10);
    else if (a === '--api-key' && args[i + 1] !== undefined) options.apiKey = args[++i];
    else if (a === '--help' || a === '-h') options.help = true;
  }

  return options;
}

async function runSetupWizard(options = {}) {
  const nonInteractive = Boolean(options.nonInteractive);
  const envPath = path.join(ROOT, '.env');

  if (!nonInteractive) {
    banner();
  }

  const rl = nonInteractive ? null : readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // ------------------------------------------------------------------
    // Step 1: Configuration (.env)
    // ------------------------------------------------------------------
    const currentPort = options.port || process.env.PORT || '9655';
    const currentHost = options.host || process.env.HOST || '127.0.0.1';
    const currentApiKey = options.apiKey !== undefined ? options.apiKey : (process.env.PROXY_API_KEY || '');

    let chosenPort = currentPort;
    let chosenHost = currentHost;
    let chosenApiKey = currentApiKey;

    if (!nonInteractive && rl) {
      console.log(`${c.bold}[1/5] Proxy Network Configuration${c.reset}`);
      chosenPort = await ask(rl, 'Proxy HTTP Port', currentPort);
      console.log(`${c.dim}Bind host: 127.0.0.1 (local only, secure) or 0.0.0.0 (all interfaces)${c.reset}`);
      chosenHost = await ask(rl, 'Bind Host', currentHost);

      console.log(`\n${c.bold}[2/5] Security: Proxy API Key${c.reset}`);
      console.log('Protect your local proxy with a Bearer API key:');
      console.log('  1 - Generate a secure random API key');
      console.log('  2 - Enter custom API key');
      console.log('  3 - No API key (unauthenticated loopback access)');
      const keyChoice = await ask(rl, 'Selection [1/2/3]', currentApiKey ? '2' : '1');

      if (keyChoice === '1') {
        chosenApiKey = `sk-deepseek-${crypto.randomBytes(16).toString('hex')}`;
        console.log(`  ${c.green}Generated secure API key:${c.reset} ${chosenApiKey}`);
      } else if (keyChoice === '2') {
        chosenApiKey = await ask(rl, 'Enter API key', currentApiKey || 'my-secret-proxy-key');
      } else {
        chosenApiKey = '';
        console.log(`  ${c.yellow}No API key configured (open loopback).${c.reset}`);
      }
    }

    // Save .env updates
    const envUpdates = {
      PORT: chosenPort,
      HOST: chosenHost,
      PROXY_API_KEY: chosenApiKey,
    };
    updateEnvFile(envPath, envUpdates);
    // Reflect saved values in current process.env
    process.env.PORT = chosenPort;
    process.env.HOST = chosenHost;
    process.env.PROXY_API_KEY = chosenApiKey;
    console.log(`\n  ${c.green}✔ Configuration saved to ${envPath}${c.reset}`);

    // ------------------------------------------------------------------
    // Step 2: Browser Engine
    // ------------------------------------------------------------------
    console.log(`\n${c.bold}[3/5] Chromium Browser Verification${c.reset}`);
    let browserPath = resolveChromePath();
    if (browserPath) {
      console.log(`  ${c.green}✔ Browser found:${c.reset} ${browserPath}`);
    } else {
      console.log(`  ${c.yellow}⚠️ No Chromium browser found.${c.reset}`);
      let shouldInstallBrowser = options.installBrowser;
      if (!nonInteractive && !options.skipBrowser && rl) {
        shouldInstallBrowser = await askYesNo(
          rl,
          'Auto-download Playwright Chromium browser now for login capture?',
          true
        );
      }
      if (shouldInstallBrowser) {
        console.log('  Downloading Chromium browser via Playwright helper...');
        const installed = ensureBrowser(true);
        if (installed) {
          browserPath = installed;
          console.log(`  ${c.green}✔ Browser installed successfully:${c.reset} ${installed}`);
        } else {
          console.log(`  ${c.red}✖ Failed to auto-download browser. You can run 'npm run browser:install' later.${c.reset}`);
        }
      } else {
        console.log(`  ${c.dim}Skipped browser installation.${c.reset}`);
      }
    }

    // ------------------------------------------------------------------
    // Step 3: DeepSeek Account Credentials
    // ------------------------------------------------------------------
    console.log(`\n${c.bold}[4/5] DeepSeek Account Authentication${c.reset}`);
    const authFile = defaultAuthOutputPath(process.env, ROOT);
    const authReady = hasPopulatedAuth(authFile);

    if (authReady) {
      console.log(`  ${c.green}✔ Account credentials file detected:${c.reset} ${authFile}`);
    } else {
      console.log(`  ${c.yellow}⚠️ No valid credentials found at ${authFile}.${c.reset}`);
      let shouldRunLogin = false;
      if (!nonInteractive && rl && browserPath) {
        shouldRunLogin = await askYesNo(
          rl,
          'Would you like to open DeepSeek login browser now to capture credentials?',
          false
        );
      }
      if (shouldRunLogin) {
        console.log('  Launching DeepSeek auth helper...');
        const authScript = path.join(__dirname, 'deepseek_chrome_auth.js');
        spawnSync(process.execPath, [authScript], { stdio: 'inherit', env: process.env });
      } else {
        console.log(`  ${c.dim}You can capture credentials anytime with: npm run auth${c.reset}`);
      }
    }

    // ------------------------------------------------------------------
    // Step 4: Systemd Service Installation (Linux with active systemd)
    // ------------------------------------------------------------------
    if (process.platform === 'linux') {
      console.log(`\n${c.bold}[5/5] Linux Systemd Service Setup${c.reset}`);
      if (!isSystemdAvailable()) {
        console.log(`  ${c.dim}systemd is not active in this environment (container/WSL/alternate init); skipping service setup.${c.reset}`);
        console.log(`  ${c.dim}Run proxy in foreground with: NON_INTERACTIVE=1 npm start${c.reset}`);
      } else {
        const unitPath = '/etc/systemd/system/free-deepseek-api.service';
        if (fs.existsSync(unitPath)) {
          console.log(`  ${c.green}✔ free-deepseek-api.service is already installed.${c.reset}`);
        } else {
          let shouldInstallService = options.installService;
          if (!nonInteractive && !options.skipService && rl) {
            shouldInstallService = await askYesNo(
              rl,
              'Install FreeDeepseekAPI as a background systemd service now?',
              false
            );
          }
          if (shouldInstallService) {
            const installScript = path.join(ROOT, 'deploy', 'install.sh');
            const installArgs = [installScript, '--current-user', `--port=${chosenPort}`, `--host=${chosenHost}`, '--non-interactive'];
            const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
            let res;
            if (isRoot) {
              console.log('  Running service installer as root...');
              res = spawnSync('bash', installArgs, { stdio: 'inherit', env: process.env });
            } else {
              console.log('  Running service installer with sudo...');
              res = spawnSync('sudo', ['bash', ...installArgs], { stdio: 'inherit', env: process.env });
            }
            if (res.status === 0) {
              console.log(`  ${c.green}✔ Systemd service installed and started!${c.reset}`);
            } else {
              const reason = res.error ? res.error.message : `exit code ${res.status}`;
              console.log(`  ${c.yellow}⚠️ Service installer finished with ${reason}. You can run 'sudo ./deploy/install.sh' manually.${c.reset}`);
            }
          } else {
            console.log(`  ${c.dim}Skipped systemd installation. (To install later: sudo ./deploy/install.sh)${c.reset}`);
          }
        }
      }
    }

    // ------------------------------------------------------------------
    // Final Diagnostics & Instructions
    // ------------------------------------------------------------------
    console.log(`\n${c.bold}Running diagnostic health check...${c.reset}`);
    const report = await runDoctor({ offline: options.offline });
    printReport(report, { offline: options.offline });

    const probeHost = formatProbeHost(chosenHost);
    console.log(`\n${c.green}${c.bold}======================================================${c.reset}`);
    console.log(`${c.bold}              Setup Completed Successfully!            ${c.reset}`);
    console.log(`${c.green}${c.bold}======================================================${c.reset}`);
    console.log('Quick commands:');
    console.log(`  ${c.bold}Interactive CLI:${c.reset}    npm run cli        (or ./cli.js)`);
    console.log(`  ${c.bold}Diagnostics:${c.reset}        npm run doctor`);
    console.log(`  ${c.bold}Start Foreground:${c.reset}   npm start`);
    if (process.platform === 'linux' && isSystemdAvailable()) {
      console.log(`  ${c.bold}Service Status:${c.reset}     npm run cli service status`);
      console.log(`  ${c.bold}Service Logs:${c.reset}       npm run cli service logs`);
    }
    if (chosenApiKey) {
      console.log(`\nTest API Endpoint:`);
      console.log(`  curl -H "Authorization: Bearer ${chosenApiKey}" http://${probeHost}:${chosenPort}/v1/models`);
    } else {
      console.log(`\nTest API Endpoint:`);
      console.log(`  curl http://${probeHost}:${chosenPort}/v1/models`);
    }
    console.log(`${c.green}======================================================${c.reset}\n`);

    return 0;
  } finally {
    if (rl) rl.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`FreeDeepseekAPI Setup Wizard

Usage:
  node scripts/setup_wizard.js [options]
  npm run setup [-- options]

Options:
  --non-interactive, -y    Run without prompts using default / provided values
  --port=<PORT>            Set proxy port (default: 9655)
  --host=<HOST>            Set bind host (default: 127.0.0.1)
  --api-key=<KEY>          Set proxy authorization key
  --install-browser        Auto-install Playwright Chromium if missing
  --skip-browser           Skip browser check and installation
  --install-service        Install Linux systemd service (requires sudo)
  --skip-service           Skip systemd service installation
  --offline                Run diagnostic checks in offline mode
  --help, -h               Show this help screen
`);
    return 0;
  }

  return await runSetupWizard(options);
}

if (require.main === module) {
  main()
    .then(code => process.exit(code ?? 0))
    .catch(e => {
      console.error('[setup] ERROR:', e.message);
      process.exit(1);
    });
}

module.exports = {
  runSetupWizard,
  updateEnvFile,
  parseArgs,
};
