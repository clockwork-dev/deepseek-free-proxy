#!/usr/bin/env node
/**
 * Browser detection and auto-installation helper for FreeDeepseekAPI.
 * Checks for Chrome / Chromium / Playwright / Puppeteer browser binaries.
 * If missing and autoInstall is requested, automatically downloads Chromium via Playwright / npx.
 */

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const qwenRepoRoot = path.resolve(repoRoot, '..', 'FreeQwenApi');

function findSystemExecutable(binName) {
    if (process.platform === 'win32') {
        try {
            const out = execFileSync('where', [binName], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
            const line = out.split(/\r?\n/).find(l => l.trim().length > 0);
            if (line && fs.existsSync(line.trim())) return line.trim();
        } catch {}
        return '';
    }
    try {
        const out = execFileSync('which', [binName], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
        const line = out.trim();
        if (line && fs.existsSync(line)) return line;
    } catch {}
    return '';
}

function resolveChromePath() {
    if (process.env.CHROME_PATH) {
        return fs.existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : '';
    }

    // 1. Check bundled Puppeteer in project or neighboring project
    for (const base of [repoRoot, qwenRepoRoot]) {
        try {
            const puppeteerPath = require.resolve('puppeteer', { paths: [base] });
            const puppeteer = require(puppeteerPath);
            if (typeof puppeteer.executablePath === 'function') {
                const p = puppeteer.executablePath();
                if (p && fs.existsSync(p)) return p;
            }
        } catch {}
    }

    // 2. Check Puppeteer cache locations (~/.cache/puppeteer/chrome)
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (home) {
        const pupCacheRoot = path.join(home, '.cache', 'puppeteer', 'chrome');
        if (fs.existsSync(pupCacheRoot)) {
            try {
                const candidates = fs.readdirSync(pupCacheRoot).flatMap((dir) => {
                    const baseDir = path.join(pupCacheRoot, dir);
                    if (process.platform === 'darwin') {
                        return [
                            path.join(baseDir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
                            path.join(baseDir, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
                        ];
                    }
                    if (process.platform === 'win32') {
                        return [
                            path.join(baseDir, 'chrome-win64', 'chrome.exe'),
                            path.join(baseDir, 'chrome.exe'),
                        ];
                    }
                    return [
                        path.join(baseDir, 'chrome-linux64', 'chrome'),
                        path.join(baseDir, 'chrome-linux64', 'chrome.exe'),
                    ];
                }).filter((p) => p && fs.existsSync(p)).sort().reverse();

                if (candidates[0]) return candidates[0];
            } catch {}
        }

        // 3. Check Playwright cache locations (~/.cache/ms-playwright or %LOCALAPPDATA%\ms-playwright)
        const pwCacheDirs = [
            path.join(home, '.cache', 'ms-playwright'),
            process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : '',
            process.env.PLAYWRIGHT_BROWSERS_PATH || '',
        ].filter(Boolean);

        for (const pwCache of pwCacheDirs) {
            if (fs.existsSync(pwCache)) {
                try {
                    const entries = fs.readdirSync(pwCache);
                    // Search for chromium-* folders
                    const chromiumDirs = entries
                        .filter(e => e.startsWith('chromium-'))
                        .map(e => path.join(pwCache, e));

                    for (const cDir of chromiumDirs.reverse()) {
                        const candidates = [
                            // Linux
                            path.join(cDir, 'chrome-linux', 'chrome'),
                            path.join(cDir, 'chrome-linux64', 'chrome'),
                            // Mac
                            path.join(cDir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
                            path.join(cDir, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
                            // Windows
                            path.join(cDir, 'chrome-win', 'chrome.exe'),
                            path.join(cDir, 'chrome-win64', 'chrome.exe'),
                        ];
                        for (const cand of candidates) {
                            if (fs.existsSync(cand)) return cand;
                        }
                    }
                } catch {}
            }
        }
    }

    // 4. Check system binaries via PATH
    const systemBins = process.platform === 'win32'
        ? ['chrome.exe', 'msedge.exe']
        : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];

    for (const bin of systemBins) {
        const found = findSystemExecutable(bin);
        if (found) return found;
    }

    // 5. Check well-known OS default install paths
    if (process.platform === 'win32') {
        const candidates = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ];
        for (const c of candidates) {
            if (fs.existsSync(c)) return c;
        }
    } else if (process.platform === 'darwin') {
        const candidates = [
            '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ];
        for (const c of candidates) {
            if (fs.existsSync(c)) return c;
        }
    } else if (process.platform === 'linux') {
        const candidates = [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
            '/usr/bin/microsoft-edge',
        ];
        for (const c of candidates) {
            if (fs.existsSync(c)) return c;
        }
    }

    return '';
}

function installPlaywrightChromium() {
    console.log('[browser] Браузер Chrome/Chromium не обнаружен в системе.');
    console.log('[browser] Автоматическая установка Chromium через npx --yes playwright...');

    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const result = spawnSync(npxCmd, ['--yes', 'playwright', 'install', 'chromium'], {
        stdio: 'inherit',
        env: process.env,
        shell: false,
    });

    if (result.status === 0) {
        console.log('[browser] Chromium успешно установлен через Playwright.');
        return resolveChromePath();
    } else {
        console.warn(`[browser] Ошибка при установке Chromium через npx playwright (код ${result.status}).`);
        return '';
    }
}

function ensureBrowser(autoInstall = true) {
    if (process.env.CHROME_PATH) {
        return fs.existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : '';
    }

    let p = resolveChromePath();
    if (p) return p;

    if (autoInstall) {
        p = installPlaywrightChromium();
        if (p) return p;
    }

    return '';
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const forceInstall = args.includes('--install') || args.includes('install');
    if (forceInstall) {
        const p = installPlaywrightChromium();
        if (p) {
            console.log(`[browser] Найден путь к браузеру: ${p}`);
            process.exit(0);
        } else {
            console.error('[browser] Не удалось установить или найти браузер.');
            process.exit(1);
        }
    } else {
        const p = ensureBrowser(false);
        if (p) {
            console.log(`[browser] Найден браузер: ${p}`);
            process.exit(0);
        } else {
            console.log('[browser] Браузер не найден. Запуск установки...');
            const installed = ensureBrowser(true);
            if (installed) {
                console.log(`[browser] Браузер готов: ${installed}`);
                process.exit(0);
            } else {
                console.error('[browser] Браузер отсутствует. Установите chromium/google-chrome или запустите npm run browser:install');
                process.exit(1);
            }
        }
    }
}

module.exports = {
    resolveChromePath,
    ensureBrowser,
    installPlaywrightChromium,
};
