#!/usr/bin/env node
'use strict';

/**
 * FreeDeepseekAPI Doctor - Diagnostics & System Health Checker
 * Checks Node version, browser availability, network reachability,
 * systemd service status, and account credentials.
 */

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { execFileSync } = require('child_process');
const { loadDotEnv } = require('../lib/env');
const { resolveChromePath } = require('./ensure_browser');

const ROOT = path.resolve(__dirname, '..');
if (require.main === module) loadDotEnv(path.join(ROOT, '.env'));

const DEFAULT_AUTH = process.env.DEEPSEEK_AUTH_PATH || path.join(ROOT, 'deepseek-auth.json');
const DEFAULT_WASM = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

// ANSI styling helper
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
};

const TAG = {
  ok: `${c.green}${c.bold}[OK]${c.reset}  `,
  warn: `${c.yellow}${c.bold}[WARN]${c.reset}`,
  fail: `${c.red}${c.bold}[FAIL]${c.reset}`,
  info: `${c.cyan}${c.bold}[INFO]${c.reset}`,
};

function isTruthy(v) {
  return /^(1|true|yes|on)$/i.test(String(v || ''));
}

function argHas(args, ...names) {
  return args.some(a => names.includes(a));
}

function authPaths() {
  if (process.env.DEEPSEEK_AUTH_DIR && fs.existsSync(process.env.DEEPSEEK_AUTH_DIR)) {
    return fs.readdirSync(process.env.DEEPSEEK_AUTH_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(f => path.join(process.env.DEEPSEEK_AUTH_DIR, f));
  }
  if (process.env.DEEPSEEK_AUTH_PATH) {
    if (process.env.DEEPSEEK_AUTH_PATH.includes(',')) {
      return process.env.DEEPSEEK_AUTH_PATH.split(',').map(s => s.trim()).filter(Boolean);
    }
    return [process.env.DEEPSEEK_AUTH_PATH.trim()];
  }
  return [path.join(ROOT, 'deepseek-auth.json')];
}

function parseJwtClaims(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function checkAuthFile(file) {
  const issues = [];
  const warnings = [];
  let auth = null;
  let metadata = {};

  if (!fs.existsSync(file)) {
    return { file, ok: false, issues: ['auth file missing'], warnings: [], auth: null, metadata: {} };
  }

  try {
    auth = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { file, ok: false, issues: [`invalid JSON: ${e.message}`], warnings: [], auth: null, metadata: {} };
  }

  if (!auth.token) issues.push('token missing');
  if (!auth.cookie) issues.push('cookie missing');
  if (!auth.wasmUrl) issues.push('wasmUrl missing');

  if (auth.token) {
    const claims = parseJwtClaims(auth.token);
    if (claims) {
      metadata.jwt = claims;
      if (claims.exp) {
        const expDate = new Date(claims.exp * 1000);
        metadata.expiresAt = expDate.toISOString();
        if (expDate < new Date()) {
          issues.push(`token expired at ${expDate.toISOString()}`);
        }
      }
    } else {
      metadata.tokenLength = auth.token.length;
      metadata.tokenFormat = /^[0-9a-fA-F]{64}$/.test(auth.token) ? 'hex64' : 'opaque';
    }
  }

  if (auth.cookie && !auth.cookie.includes('ds_session_id')) {
    warnings.push('cookie does not contain ds_session_id (may trigger unauthorized)');
  }

  if (process.platform !== 'win32') {
    try {
      const mode = fs.statSync(file).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        issues.push(`permissions too open: ${mode.toString(8)} (run: chmod 600 ${file})`);
      }
    } catch {}
  }

  return {
    file,
    ok: issues.length === 0,
    issues,
    warnings,
    auth,
    metadata
  };
}

async function liveCheck(auth) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36',
    'x-client-platform': 'web',
    'x-client-version': '2.0.0',
    'x-client-locale': 'ru',
    'x-client-timezone-offset': '14400',
    'x-app-version': '2.0.0',
    'Authorization': `Bearer ${auth.token || ''}`,
    'x-hif-dliq': auth.hif_dliq || '',
    'x-hif-leim': auth.hif_leim || '',
    'Origin': 'https://chat.deepseek.com',
    'Referer': 'https://chat.deepseek.com/',
    'Cookie': auth.cookie || '',
    'Content-Type': 'application/json',
  };
  const checks = [];
  try {
    const base = String(process.env.DEEPSEEK_BASE_URL || 'https://chat.deepseek.com').replace(/\/+$/, '');
    const startTime = Date.now();
    const r = await fetch(`${base}/api/v0/chat/create_pow_challenge`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
      signal: AbortSignal.timeout(12000),
    });
    const latency = Date.now() - startTime;
    const text = await r.text();
    let challenge = null;
    let bizCode = null;
    let bizMsg = null;
    try {
      const parsed = JSON.parse(text);
      challenge = parsed?.data?.biz_data?.challenge || null;
      bizCode = parsed?.code ?? null;
      bizMsg = parsed?.msg ?? null;
    } catch {}

    const isChallengeValid = r.ok && Boolean(challenge);
    let detail = '';
    if (!challenge) {
      if (bizMsg) detail = `DeepSeek message: ${bizMsg} (code ${bizCode})`;
      else detail = text.substring(0, 120);
    }

    checks.push({
      name: 'pow challenge',
      ok: isChallengeValid,
      status: r.status,
      latencyMs: latency,
      detail,
    });
  } catch (e) {
    checks.push({ name: 'pow challenge', ok: false, error: e.message });
  }
  return checks;
}

function checkNodeVersion() {
  const ver = process.version;
  const major = parseInt(ver.slice(1).split('.')[0], 10);
  if (major < 18) {
    return {
      status: 'fail',
      version: ver,
      message: `Node.js version ${ver} is unsupported. Node.js >= 18.0.0 is required.`,
    };
  }
  if (major < 22) {
    return {
      status: 'warn',
      version: ver,
      message: `Node.js ${ver} detected. Recommended: Node.js >= 22 (required for native WebSocket during 'npm run auth').`,
    };
  }
  return {
    status: 'ok',
    version: ver,
    message: `Node.js ${ver} (supported, native WebSocket available)`,
  };
}

function checkBrowser() {
  const browserPath = resolveChromePath();
  if (browserPath) {
    return {
      status: 'ok',
      path: browserPath,
      message: `Chrome/Chromium found: ${browserPath}`,
    };
  }
  return {
    status: 'warn',
    path: '',
    message: 'No Chrome/Chromium found. (Will auto-download via Playwright on auth, or run: npm run browser:install)',
  };
}

async function checkNetwork() {
  const results = {};
  const baseUrl = String(process.env.DEEPSEEK_BASE_URL || 'https://chat.deepseek.com').replace(/\/+$/, '');
  let hostname = 'chat.deepseek.com';
  try {
    const u = new URL(baseUrl);
    hostname = u.hostname;
  } catch {}

  // 1. DNS check
  try {
    const dnsStart = Date.now();
    const lookup = await dns.lookup(hostname);
    results.dns = {
      status: 'ok',
      host: hostname,
      address: lookup.address,
      latencyMs: Date.now() - dnsStart,
      message: `DNS resolved ${hostname} -> ${lookup.address} (${Date.now() - dnsStart}ms)`,
    };
  } catch (e) {
    results.dns = {
      status: 'fail',
      host: hostname,
      error: e.message,
      message: `DNS lookup failed for ${hostname}: ${e.message}`,
    };
  }

  // 2. HTTPS reachability
  try {
    const httpsStart = Date.now();
    const resp = await fetch(baseUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (FreeDeepseekAPI-Doctor)' },
      signal: AbortSignal.timeout(10000),
    });
    const latency = Date.now() - httpsStart;
    results.https = {
      status: 'ok',
      url: baseUrl,
      httpStatus: resp.status,
      latencyMs: latency,
      message: `HTTPS connection to ${baseUrl} succeeded (HTTP ${resp.status}, ${latency}ms)`,
    };
  } catch (e) {
    results.https = {
      status: 'fail',
      url: baseUrl,
      error: e.message,
      message: `HTTPS connection to ${baseUrl} failed: ${e.message}`,
    };
  }

  return results;
}

async function checkLocalProxy() {
  const port = process.env.PORT || 9655;
  const host = process.env.HOST || '127.0.0.1';
  const url = `http://${host}:${port}/health`;
  try {
    const start = Date.now();
    const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
    const latency = Date.now() - start;
    if (resp.ok) {
      return {
        status: 'ok',
        running: true,
        port,
        host,
        latencyMs: latency,
        message: `Local proxy is running on ${host}:${port} (${latency}ms)`,
      };
    }
  } catch {}

  // Also check /v1/models if /health is not implemented
  try {
    const start = Date.now();
    const modelsUrl = `http://${host}:${port}/v1/models`;
    const resp = await fetch(modelsUrl, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      return {
        status: 'ok',
        running: true,
        port,
        host,
        latencyMs: Date.now() - start,
        message: `Local proxy is running on ${host}:${port}`,
      };
    }
  } catch {}

  return {
    status: 'info',
    running: false,
    port,
    host,
    message: `Local proxy is not currently running on ${host}:${port} (start with: npm start or cli.js service start)`,
  };
}

function checkSystemdService() {
  if (process.platform !== 'linux') {
    return {
      status: 'info',
      installed: false,
      active: false,
      message: 'Systemd is only available on Linux',
    };
  }

  const unitPath = '/etc/systemd/system/free-deepseek-api.service';
  const installed = fs.existsSync(unitPath);

  if (!installed) {
    return {
      status: 'info',
      installed: false,
      active: false,
      message: 'free-deepseek-api.service is not installed (install: sudo ./deploy/install.sh)',
    };
  }

  try {
    const statusOut = execFileSync('systemctl', ['is-active', 'free-deepseek-api'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();

    if (statusOut === 'active') {
      return {
        status: 'ok',
        installed: true,
        active: true,
        serviceStatus: statusOut,
        message: `free-deepseek-api.service: active (running)`,
      };
    } else {
      return {
        status: 'warn',
        installed: true,
        active: false,
        serviceStatus: statusOut,
        message: `free-deepseek-api.service: ${statusOut} (start: sudo systemctl start free-deepseek-api)`,
      };
    }
  } catch {
    return {
      status: 'warn',
      installed: true,
      active: false,
      message: 'free-deepseek-api.service is installed but inactive (start: sudo systemctl start free-deepseek-api)',
    };
  }
}

async function runDoctor(opts = {}) {
  const offline = Boolean(opts.offline);
  const json = Boolean(opts.json);

  const report = {
    timestamp: new Date().toISOString(),
    node: checkNodeVersion(),
    browser: checkBrowser(),
    network: offline ? { offline: true } : await checkNetwork(),
    systemd: checkSystemdService(),
    proxy: offline ? { skipped: true } : await checkLocalProxy(),
    accounts: [],
    summary: { ok: 0, warn: 0, fail: 0 },
  };

  const files = authPaths();
  for (const file of files) {
    const authCheck = checkAuthFile(file);
    const item = {
      file: authCheck.file,
      ok: authCheck.ok,
      issues: authCheck.issues,
      warnings: authCheck.warnings,
      metadata: authCheck.metadata,
      live: [],
    };

    if (!offline && authCheck.auth && authCheck.ok) {
      item.live = await liveCheck(authCheck.auth);
    }
    report.accounts.push(item);
  }

  // Calculate summary counts
  if (report.node.status === 'fail') report.summary.fail++;
  else if (report.node.status === 'warn') report.summary.warn++;
  else report.summary.ok++;

  if (report.browser.status === 'fail') report.summary.fail++;
  else if (report.browser.status === 'warn') report.summary.warn++;
  else report.summary.ok++;

  if (!offline && report.network && !report.network.offline) {
    if (report.network.dns?.status === 'fail') report.summary.fail++;
    else if (report.network.dns?.status === 'ok') report.summary.ok++;

    if (report.network.https?.status === 'fail') report.summary.fail++;
    else if (report.network.https?.status === 'ok') report.summary.ok++;
  }

  if (report.systemd.status === 'fail') report.summary.fail++;
  else if (report.systemd.status === 'warn') report.summary.warn++;
  else if (report.systemd.status === 'ok') report.summary.ok++;

  for (const acc of report.accounts) {
    if (!acc.ok) {
      report.summary.fail++;
    } else {
      let liveFailed = false;
      for (const lc of acc.live) {
        if (!lc.ok) {
          liveFailed = true;
          report.summary.fail++;
        }
      }
      if (!liveFailed) report.summary.ok++;
    }
  }

  return report;
}

function printReport(report, { offline = false } = {}) {
  console.log(`${c.bold}${c.cyan}======================================================${c.reset}`);
  console.log(`${c.bold}         FreeDeepseekAPI System Doctor${c.reset}`);
  console.log(`${c.bold}${c.cyan}======================================================${c.reset}`);

  // 1. Runtime & Node
  console.log(`\n${c.bold}Runtime & Environment:${c.reset}`);
  if (report.node.status === 'ok') console.log(`  ${TAG.ok} ${report.node.message}`);
  else if (report.node.status === 'warn') console.log(`  ${TAG.warn} ${report.node.message}`);
  else console.log(`  ${TAG.fail} ${report.node.message}`);

  // 2. Browser
  console.log(`\n${c.bold}Browser (for auth login capture):${c.reset}`);
  if (report.browser.status === 'ok') console.log(`  ${TAG.ok} ${report.browser.message}`);
  else console.log(`  ${TAG.warn} ${report.browser.message}`);

  // 3. Network Reachability
  if (!offline && report.network && !report.network.offline) {
    console.log(`\n${c.bold}Network Reachability:${c.reset}`);
    if (report.network.dns) {
      if (report.network.dns.status === 'ok') console.log(`  ${TAG.ok} ${report.network.dns.message}`);
      else console.log(`  ${TAG.fail} ${report.network.dns.message}`);
    }
    if (report.network.https) {
      if (report.network.https.status === 'ok') console.log(`  ${TAG.ok} ${report.network.https.message}`);
      else console.log(`  ${TAG.fail} ${report.network.https.message}`);
    }
  }

  // 4. Local Proxy Status
  if (!offline && report.proxy && !report.proxy.skipped) {
    console.log(`\n${c.bold}Local Proxy Server:${c.reset}`);
    if (report.proxy.running) console.log(`  ${TAG.ok} ${report.proxy.message}`);
    else console.log(`  ${TAG.info} ${report.proxy.message}`);
  }

  // 5. Systemd Service
  if (process.platform === 'linux') {
    console.log(`\n${c.bold}Systemd Service:${c.reset}`);
    if (report.systemd.status === 'ok') console.log(`  ${TAG.ok} ${report.systemd.message}`);
    else if (report.systemd.status === 'warn') console.log(`  ${TAG.warn} ${report.systemd.message}`);
    else console.log(`  ${TAG.info} ${report.systemd.message}`);
  }

  // 6. DeepSeek Accounts & Credentials
  console.log(`\n${c.bold}DeepSeek Accounts:${c.reset}`);
  console.log(`  ${c.dim}Source: ${process.env.DEEPSEEK_AUTH_DIR ? 'DEEPSEEK_AUTH_DIR' : 'DEEPSEEK_AUTH_PATH / default'}${c.reset}`);

  for (const acc of report.accounts) {
    console.log(`\n  Auth file: ${c.bold}${acc.file}${c.reset}`);
    if (acc.ok) {
      console.log(`    ${TAG.ok} auth file looks OK`);
      if (acc.metadata.expiresAt) {
        console.log(`    ${TAG.info} Token expiration: ${acc.metadata.expiresAt}`);
      }
      for (const w of acc.warnings) {
        console.log(`    ${TAG.warn} ${w}`);
      }
    } else {
      for (const issue of acc.issues) {
        console.log(`    ${TAG.fail} ${issue}`);
      }
    }

    if (!offline && acc.live && acc.live.length > 0) {
      for (const lc of acc.live) {
        if (lc.ok) {
          console.log(`    ${TAG.ok} live ${lc.name}: HTTP ${lc.status} (${lc.latencyMs}ms, challenge verified)`);
        } else {
          console.log(`    ${TAG.fail} live ${lc.name}: ${lc.error || `HTTP ${lc.status}${lc.detail ? ` — ${lc.detail}` : ''}`} (run npm run auth or npm run auth:import)`);
        }
      }
    }
  }

  // 7. Summary
  console.log(`\n${c.bold}${c.cyan}------------------------------------------------------${c.reset}`);
  const s = report.summary;
  const statusColor = s.fail > 0 ? c.red : (s.warn > 0 ? c.yellow : c.green);
  console.log(`Summary: ${c.green}${s.ok} OK${c.reset}, ${c.yellow}${s.warn} WARN${c.reset}, ${c.red}${s.fail} FAIL${c.reset}`);
  if (s.fail === 0) {
    console.log(`${statusColor}${c.bold}All critical checks passed successfully!${c.reset}`);
  } else {
    console.log(`${c.red}${c.bold}Some diagnostics failed. Please review the errors above.${c.reset}`);
  }
  console.log(`${c.bold}${c.cyan}======================================================${c.reset}`);
}

async function main(args = process.argv.slice(2)) {
  if (argHas(args, '--help', '-h')) {
    console.log(`FreeDeepseekAPI Doctor

Usage:
  node scripts/doctor.js [options]
  npm run doctor [-- options]

Options:
  --offline     Skip live DeepSeek network and PoW verification
  --json        Output diagnostic report as JSON
  --no-color    Disable ANSI color codes
  --help, -h    Show this help message
`);
    return 0;
  }

  const offline = argHas(args, '--offline') || isTruthy(process.env.DOCTOR_OFFLINE);
  const jsonMode = argHas(args, '--json');

  const report = await runDoctor({ offline, json: jsonMode });

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report, { offline });
  }

  return report.summary.fail > 0 ? 2 : 0;
}

if (require.main === module) {
  main()
    .then(code => process.exit(code))
    .catch(e => {
      console.error('[doctor] ERROR:', e.message);
      process.exit(1);
    });
}

module.exports = {
  checkAuthFile,
  authPaths,
  checkNodeVersion,
  checkBrowser,
  checkNetwork,
  checkSystemdService,
  checkLocalProxy,
  runDoctor,
  printReport,
};
