# FreeDeepseekAPI

<p align="center">
  <strong>Локальный OpenAI-compatible API proxy для DeepSeek Web Chat</strong>
</p>

<p align="center">
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-green.svg" />
  <img alt="Node.js 18 plus" src="https://img.shields.io/badge/node-18%2B-339933.svg" />
  <img alt="No npm dependencies" src="https://img.shields.io/badge/dependencies-0-blue.svg" />
  <img alt="OpenAI compatible" src="https://img.shields.io/badge/OpenAI-compatible-111111.svg" />
  <img alt="Tests Passing" src="https://img.shields.io/badge/tests-165%20passed-brightgreen.svg" />
</p>

<p align="center">
  <a href="#-быстрый-старт">Быстрый старт</a> •
  <a href="#-интерактивный-cli-и-control-center">Интерактивный CLI</a> •
  <a href="#-мультимодальность-и-vision">Мультимодальность & Vision</a> •
  <a href="#-возможности">Возможности</a> •
  <a href="#-примеры-запросов">Примеры</a> •
  <a href="#-модели">Модели</a> •
  <a href="#-постоянный-сервис-на-linux-systemd">Systemd сервис</a> •
  <a href="#-подключение-к-hermes-agent">Hermes</a> •
  <a href="#-open-webui">Open WebUI</a>
</p>

FreeDeepseekAPI поднимает локальный API-сервер для **DeepSeek Web Chat** (`chat.deepseek.com`) и позволяет подключать DeepSeek Web к Open WebUI, LiteLLM, Hermes, Claude Code, OpenAI SDK-style клиентам и другим OpenAI-compatible инструментам.

Проект работает через ваш обычный залогиненный аккаунт DeepSeek в отдельном Chrome-профиле. Локальный сервер принимает API-запросы, а дальше сам ходит в DeepSeek Web через сохранённую browser-сессию.

> ⚠️ Это экспериментальный web-chat proxy. DeepSeek может менять внутренний Web API без предупреждения. Для production-кейсов надёжнее официальный платный API DeepSeek.

---

## Навигация

- [Что это даёт](#-что-это-даёт)
- [Возможности](#-возможности)
- [Быстрый старт](#-быстрый-старт)
  - [Установка одной командой (Linux & macOS)](#-установка-одной-командой-linux--macos)
- [Интерактивный CLI и Control Center](#-интерактивный-cli-и-control-center)
- [Мультимодальность и Vision (изображения)](#-мультимодальность-и-vision-изображения)
- [Постоянный сервис на Linux (systemd)](#-постоянный-сервис-на-linux-systemd)
  - [Troubleshooting: защита от `status=200/CHDIR` (`ProtectHome` / `WorkingDirectory`)](#troubleshooting-защита-от-status200chdir-protecthome--workingdirectory)
- [Modernized Diagnostics (doctor)](#-modernized-diagnostics-doctor)
- [Модульная архитектура (`src/`)](#-модульная-архитектура-src)
- [Windows запуск](#-windows-запуск)
- [Linux / Chromium запуск](#-linux--chromium-запуск)
- [VPS / headless запуск](#-vps--headless-запуск)
- [Rootless Podman](#-rootless-podman)
- [Session reuse и сброс чатов](#-session-reuse-и-сброс-чатов)
- [Multi-account pool](#-multi-account-pool)
- [Проверка работы](#-проверка-работы)
- [Примеры запросов](#-примеры-запросов)
  - [Chat Completions](#chat-completions)
  - [Reasoning](#reasoning)
  - [Web search](#web-search)
  - [Streaming](#streaming)
  - [Anthropic Messages API](#anthropic-messages-api)
  - [OpenAI Responses API](#openai-responses-api)
  - [Tool calling](#tool-calling)
  - [Мультимодальные запросы (OpenAI & Anthropic)](#мультимодальные-запросы-openai--anthropic)
- [Модели](#-модели)
- [Endpoints](#-endpoints)
- [Подключение к Hermes Agent](#-подключение-к-hermes-agent)
- [Open WebUI](#-open-webui)
- [Обновить логин](#-обновить-логин)
- [Тесты](#-тесты)
- [Статус проекта](#-статус-проекта)

---

## ✨ Что это даёт

- Использовать DeepSeek Web как локальный API endpoint с полной совместимостью OpenAI, Anthropic Messages и Responses API.
- Подключать DeepSeek к Open WebUI, LiteLLM, LibreChat и любым сторонним агентам и IDE.
- Получать обычные JSON-ответы или ultra-fast streaming SSE.
- Работать с reasoning-моделями с извлечением честного `reasoning_content`.
- Отправлять изображения (URL и base64) с параллельной загрузкой и интеллектуальным LRU-кэшированием.
- Управлять прокси через удобный интерактивный CLI Control Center или поднимать в виде systemd-демона.
- Держать независимые изолированные web-сессии для разных пользователей и агентских циклов.

## 🚀 Возможности

- **OpenAI-compatible API:** `POST /v1/chat/completions`
- **Anthropic-compatible shim:** `POST /v1/messages`
- **OpenAI Responses shim:** `POST /v1/responses`
- **Enhanced Multimodal Engine:** параллельная загрузка изображений (`Promise.all`), авто-скачивание внешних URL картинок, magic byte MIME sniffing (PNG, JPEG, WebP, GIF, BMP), SSRF-фильтрация и LRU-кэш на 30 мин.
- **Интерактивный TUI Control Center:** `npm run cli` / `free-deepseek-cli` с живыми индикаторами статуса сервиса, токенов, браузера и сети.
- **Modernized Diagnostics:** детальный отчёт `npm run doctor` с цветовой индикацией (`[OK]`, `[WARN]`, `[FAIL]`), замером задержки сети и поддержкой `--json`.
- **Systemd Service Integration:** готовые скрипты установки `deploy/install.sh` и управление службой прямо из CLI (`cli.js service status|logs|restart`).
- **Streaming:** SSE chunks и обычные non-stream JSON-ответы с keep-alive пингами.
- **Reasoning output:** отдельный `reasoning_content` для thinking-моделей.
- **Tool calling:** надёжный парсинг OpenAI tools, Anthropic tools, Responses function tools и DeepSeek DSML.
- **Multi-account pool:** sticky account per agent session, round-robin распределение и авто-cooldown при rate limits.
- **Zero heavy dependencies:** 100% чистый Node.js без внешних npm runtime-пакетов.

---

## ⚡ Быстрый старт

### Установка одной командой (Linux & macOS)

Кроссплатформенный установщик автоматически проверит/установит `curl`, `git`, `Node.js >= 18` и `npm`, клонирует или безопасно обновит репозиторий (сохраняя существующие `.env` и `deepseek-auth.json`), выполнит `npm install --omit=dev` и настроит фоновый сервис:

```bash
curl -fsSL https://raw.githubusercontent.com/clockwork-dev/deepseek-free-proxy/main/deploy/quick-install.sh | bash
```

**Поддерживаемые платформы:**
- **Linux (`apt`, `dnf`/`yum`, `pacman`, `apk`, `zypper`)**: Debian, Ubuntu, Fedora, RHEL, CentOS, Rocky, AlmaLinux, Arch, Alpine, openSUSE (при версии Node.js в репозитории `< 18` автоматически подтягивается Node 22 LTS).
  - При активном `systemd` и наличии прав `root`/`sudo` репозиторий ставится в `/opt/deepseek-free-proxy` и регистрируется как сервис `free-deepseek-api.service`.
  - В окружениях **без systemd** (Docker/LXC контейнеры, WSL2, Alpine OpenRC) автоматически создаются `.env` (`0600`, со сгенерированным `PROXY_API_KEY`) и `deepseek-auth.json` (`{}`) для запуска в foreground.
- **macOS (`brew`)**: автоматически использует Homebrew, клонирует проект в `~/deepseek-free-proxy` и настраивает `LaunchAgent` (`~/Library/LaunchAgents/com.deepseek.free-proxy.plist`, логи в `~/Library/Logs/deepseek-free-proxy/`).
  - Перезапуск сервиса на macOS: `launchctl kickstart -k gui/$(id -u)/com.deepseek.free-proxy`

**Неинтерактивный запуск и передача флагов (`bash -s -- ...` или env-переменные):**

```bash
# Неинтерактивная установка с явным портом и пропуском загрузки браузера
curl -fsSL https://raw.githubusercontent.com/clockwork-dev/deepseek-free-proxy/main/deploy/quick-install.sh | \
  bash -s -- --non-interactive --port=9655 --skip-browser
```

Основные опции `quick-install.sh`:
- `--install-dir=PATH` (или `INSTALL_DIR=...`) — каталог установки (по умолчанию `/opt/deepseek-free-proxy` для root/Linux systemd или `~/deepseek-free-proxy` для macOS/non-root);
- `--port=PORT` / `--host=HOST` — адрес и порт прокси (по умолчанию `127.0.0.1:9655`);
- `--current-user` — запускать systemd-сервис на Linux от текущего пользователя вместо `freedeepseek`;
- `--user-dir` — установить в `~/deepseek-free-proxy` даже при наличии `sudo`;
- `--install-browser` / `--skip-browser` — установить или пропустить Chromium Playwright для локальной авторизации;
- `--skip-service` — выполнить только локальную настройку `.env` без регистрации systemd / LaunchAgent;
- `--non-interactive`, `-y` (или `NON_INTERACTIVE=1`) — без интерактивных запросов (включается автоматически при отсутствии `/dev/tty`);
- `--branch=BRANCH` — выбрать ветку Git (по умолчанию `main`).

> 💡 На Windows (MSYS/Git Bash) используйте WSL2 или ручной `git clone` (см. раздел [Windows запуск](#-windows-запуск)).

### 1. Ручное клонирование и Setup Wizard
```bash
git clone https://github.com/clockwork-dev/deepseek-free-proxy.git
cd deepseek-free-proxy
npm run setup
```

Интерактивный мастер проведёт вас через все этапы:
1. Выбор порта (`PORT=9655`) и адреса привязки (`127.0.0.1` или `0.0.0.0`);
2. Генерация или ввод безопасного `PROXY_API_KEY`;
3. Проверка и автоматическая загрузка Chromium (Playwright/Chrome);
4. Авторизация в DeepSeek Web;
5. Опциональная установка в systemd.

### 2. Запуск Control Center
```bash
npm run cli
```

Или прямой запуск прокси-сервера:
```bash
npm start
```

---

## 🎮 Интерактивный CLI и Control Center

В репозитории реализован консольный центр управления **CLI Control Center** (`cli.js`, доступен как `npm run cli` или глобальная команда `free-deepseek-cli`).

### Вид интерфейса TUI

```text
╔═══════════════════════════════════════════════════════════════════════════╗
║                   🚀 DeepSeek Free Proxy Control Center                   ║
╚═══════════════════════════════════════════════════════════════════════════╝
  Systemd Service:  ● Active (running)       Gateway:  http://127.0.0.1:9655
  Auth Tokens:      ✔ Valid (1 account)      Browser:  ✔ Chromium Detected
─────────────────────────────────────────────────────────────────────────────
  [1] 🩺 Run Doctor Diagnostics (check network, auth, PoW, system)
  [2] 🔑 One-Click DeepSeek Login (capture web session via Chrome)
  [3] 🔍 Validate & Inspect Account Tokens (permissions, expiration)
  [4] ⚙️  Systemd Service Manager (status, logs, start, stop, restart)
  [5] 🪄 Interactive Setup Wizard (port, API keys, auto-configure)
  [6] 💬 Quick Chat Prompt (test live generation in terminal)
  [7] 🌐 Start Foreground Proxy Server
  [0] 🚪 Exit
```

### Команды CLI (неинтерактивный режим)

CLI можно использовать в скриптах, CI/CD и терминале с флагами:

| Команда | Назначение |
| --- | --- |
| `npm run cli -- doctor` (или `./cli.js doctor`) | Запуск полной диагностики системы |
| `cli.js doctor --json` | Вывод результатов диагностики в чистом JSON |
| `cli.js doctor --offline` | Локальная проверка без сетевых запросов к DeepSeek |
| `cli.js setup` | Интерактивный мастер первоначальной настройки |
| `cli.js setup -y --port 9655 --key "my-secret"` | Скриптовая настройка без подтверждений |
| `cli.js service status` | Проверка состояния Linux systemd службы |
| `cli.js service logs -f` | Просмотр живых логов через journalctl |
| `cli.js service restart` | Перезапуск службы `free-deepseek-api` |
| `cli.js auth status` | Проверка токенов, cookies и прав файлов |
| `cli.js auth login` | Запуск браузера для захвата сессии |
| `cli.js health` | Проверка доступности запущенного прокси |
| `cli.js chat -p "Привет!"` | Быстрая отправка тестового промпта |

---

## 🖼 Мультимодальность и Vision (изображения)

FreeDeepseekAPI включает производительный мультимодальный движок (`src/deepseek/multimodal.js`):

### Ключевые возможности:
1. **Параллельная загрузка изображений:** при отправке нескольких картинок они загружаются параллельно через `Promise.all` с раздельным вычислением криптографического PoW challenge для каждой.
2. **Поддержка удалённых URL картинок:** прокси автоматически скачивает изображения по внешним HTTP/HTTPS ссылкам, конвертирует их в бинарный буфер и передаёт в DeepSeek.
3. **Защита от SSRF:** встроенный фильтр блокирует запросы к `localhost`, `127.0.0.1`, `::1` и приватным подсетям локальной сети (RFC 1918 / RFC 4193).
4. **Magic Byte MIME Sniffing:** автоматическое определение типа изображения по сигнатуре первых байтов (PNG, JPEG, WebP, GIF, BMP). Корректно определяет формат даже если сервер отдал `Content-Type: application/octet-stream` или расширение файла скрыто.
5. **Интеллектуальный LRU-кэш (`ImageUploadCache`):** кэширует загруженные файлы по SHA-256 хешу на 30 минут с поддержкой LRU-вытеснения (до 256 записей). Повторные сообщения диалога используют уже загруженный `file_id` без задержек.
6. **Ограничения и безопасность:** лимит размера одного изображения — 7 МБ (`DEEPSEEK_MAX_IMAGE_BYTES`), общий объём — до 10 МБ. Превышающие лимит изображения обрабатываются без падения сервера.

---

## 🛠 Постоянный сервис на Linux (systemd)

Proxy можно запустить как надёжный системный сервис под изолированным пользователем `freedeepseek` с автоперезапуском при сбоях и загрузкой при старте ОС.

### 1. Автоматическая установка

```bash
# Установка изолированного системного сервиса из текущего каталога:
sudo ./deploy/install.sh

# Установка с копированием проекта в /opt/deepseek-free-proxy (без .git и локальных секретов):
sudo ./deploy/install.sh --install-dir=/opt/deepseek-free-proxy

# Или запуск от имени текущего пользователя:
sudo ./deploy/install.sh --current-user

# Неинтерактивная установка с явным портом:
sudo ./deploy/install.sh --non-interactive --port=9655
```

> ℹ️ Файл [`deploy/free-deepseek-api.service`](deploy/free-deepseek-api.service) — это **TEMPLATE ONLY** (шаблон для справки). Всегда используйте `deploy/install.sh` (или `deploy/quick-install.sh`), который динамически генерирует `/etc/systemd/system/free-deepseek-api.service` под ваши пути.

Инсталлятор:
- Проверяет Node.js (`>=18`) и вычисляет его реальный путь (`readlink -f`);
- Создаёт пользователя и группу `freedeepseek` (при стандартной установке);
- Выполняет pre-flight проверку прав пользователя `$SERVICE_USER` на обход и чтение `$PROJECT_DIR`, `server.js`, `$NODE_BIN` и файлов секретов до старта systemd;
- Создаёт защищённую директорию конфигурации `/etc/free-deepseek-api/` с `umask 077` и правами `0750`;
- Генерирует криптографически стойкий `proxy-api-key` (`0640`) и валидный JSON placeholder `{}` в `/etc/free-deepseek-api/deepseek-auth.json` (`0600`), если аккаунт ещё не импортирован;
- Регистрирует unit `free-deepseek-api.service` с динамическими `WorkingDirectory=$PROJECT_DIR`, `ExecStart`, `NoNewPrivileges=true`, `ProtectSystem=strict` и адаптивным `ProtectHome`;
- После запуска автоматически проверяет `systemctl is-active` и `GET /health` (при ошибке печатает последние 20 строк `journalctl -u free-deepseek-api -n 20`).

### Troubleshooting: защита от `status=200/CHDIR` (`ProtectHome` / `WorkingDirectory`)

В старых шаблонах systemd ошибка **`status=200/CHDIR`** (или `203/EXEC`) возникала по двум причинам:
1. Статичный `WorkingDirectory` (например, несуществующий `/opt/FreeDeepseekAPI`) или запуск из домашнего каталога с правами `0700` под пользователем `freedeepseek`.
2. Жёсткий `ProtectHome=true`: эта директива полностью скрывает `/home` и `/root` от процесса сервиса. Если код проекта, бинарник Node.js (`nvm`/`fnm`/`volta` в `~/.nvm`), `DEEPSEEK_AUTH_PATH` или `PROXY_API_KEY_FILE` находятся в `/home` или `/root`, systemd не сможет перейти в `WorkingDirectory` и завершится с `status=200/CHDIR`.

**Как это решается автоматически в `deploy/install.sh`:**
- `WorkingDirectory` всегда выставляется динамически на фактический `$PROJECT_DIR` (либо `/opt/deepseek-free-proxy` при `--install-dir`).
- В режиме по умолчанию `--protect-home=auto` инсталлятор проверяет `$PROJECT_DIR`, `$NODE_BIN` (включая симлинки через `readlink -f`), `$CONFIG_DIR`, `$ENV_FILE`, `$PROXY_API_KEY_FILE` и пути `DEEPSEEK_AUTH_PATH`/`DEEPSEEK_AUTH_DIR`. Если любой из них находится внутри `/home` или `/root`, автоматически выставляется `ProtectHome=read-only` вместо `ProtectHome=true` (при необходимости можно переопределить через `--protect-home=true|read-only|false`).
- Перед запуском службы выполняется pre-flight проверка прав от имени `$SERVICE_USER` с точным указанием блокирующего родительского каталога (например, `0700` на `/home/user`) и выбором решения (`--install-dir=/opt/deepseek-free-proxy` или `--current-user`).

### 2. Управление службой через CLI

```bash
./cli.js service status     # Проверить статус службы
./cli.js service logs       # Посмотреть логи
./cli.js service restart    # Перезапустить
./cli.js service stop       # Остановить
./cli.js service start      # Запустить
```

Или через стандартный `systemctl`:
```bash
sudo systemctl status free-deepseek-api
sudo journalctl -u free-deepseek-api -f
```

### 3. Удаление сервиса

```bash
sudo ./deploy/uninstall.sh         # Удаляет unit, сохраняя конфиг и ключи
sudo ./deploy/uninstall.sh --purge # Полное удаление с конфигурацией
```

---

## 🩺 Modernized Diagnostics (doctor)

Скрипт диагностики обновлён и выводит наглядные ANSI-статусы:

```bash
npm run doctor
# или через CLI:
./cli.js doctor
```

Пример вывода:
```text
============================================================
           DeepSeek Free Proxy — System Diagnostics
============================================================
[OK] Node.js Runtime: v22.12.0 (>= 18 required, native WebSocket available)
[OK] Chromium Browser: Found executable at /usr/bin/chromium
[OK] DeepSeek Web Reachability: DNS resolved, HTTPS reachable (142ms)
[OK] Systemd Service: Active (running)
[OK] Auth Account: deepseek-auth.json (1 active account, permissions 0600)
[OK] Upstream PoW Challenge: Successfully validated (HTTP 200)

>> All diagnostic checks PASSED. System is ready for operation.
```

Для скриптов и систем мониторинга доступен JSON-формат:
```bash
npm run doctor -- --json
```

---

## 🏗 Модульная архитектура (`src/`)

Кодовая база декомпозирована на чистые, изолированные модули:

```text
├── cli.js                     # Unified CLI entrypoint & interactive TUI
├── server.js                  # Thin backward-compatible entrypoint & test export
├── src/
│   ├── server.js              # HTTP server lifecycle, routing dispatcher, CORS
│   ├── routes/
│   │   ├── chat.js            # OpenAI /v1/chat/completions handler
│   │   ├── messages.js        # Anthropic /v1/messages shim
│   │   ├── responses.js       # OpenAI /v1/responses shim
│   │   ├── models.js          # /v1/models & /v1/model-capabilities
│   │   ├── sessions.js        # /v1/sessions & /reset-session
│   │   └── health.js          # /health & readiness checks
│   ├── deepseek/
│   │   ├── client.js          # Upstream Web API client, PoW solver, SSE stream
│   │   ├── multimodal.js      # Vision engine, concurrent uploads, LRU cache, SSRF
│   │   └── prompt.js          # Turn planning, prompt compaction, delta history
│   ├── accounts/
│   │   └── pool.js            # Multi-account pool, round-robin, cooldowns
│   ├── tools/
│   │   └── parser.js          # DSML, markdown fences, JSON repair, schema compaction
│   ├── sessions/
│   │   └── manager.js         # Conversation lifecycle, session reuse, auto-reset
│   └── utils/
│       ├── auth.js            # Proxy API key auth, loopback & CORS validators
│       └── streaming.js       # SSE encoding, OpenAI/Anthropic chunk adapters
├── scripts/
│   ├── doctor.js              # Upgraded color diagnostics & reachability checks
│   ├── setup_wizard.js        # Interactive & automated setup wizard
│   ├── ensure_browser.js      # Cross-platform browser resolution & auto-install
│   ├── auth.js                # Interactive Chrome login capture
│   └── auth_import.js         # CLI import for cookies and tokens
└── deploy/
    ├── quick-install.sh          # Cross-platform one-line installer (Linux & macOS)
    ├── install.sh                # Linux systemd automated installer (adaptive ProtectHome)
    ├── uninstall.sh              # Clean service uninstaller (systemd & LaunchAgent)
    └── free-deepseek-api.service # Reference systemd unit template (TEMPLATE ONLY)
```

---

## 🪟 Windows запуск

```powershell
git clone https://github.com/clockwork-dev/deepseek-free-proxy.git
cd deepseek-free-proxy
npm run auth
npm start
```

Если Chrome установлен нестандартно, явно укажите путь:
```powershell
$env:CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
npm run auth
```

---

## 🐧 Linux / Chromium запуск

```bash
git clone https://github.com/clockwork-dev/deepseek-free-proxy.git
cd deepseek-free-proxy
npm run browser:install  # Скачает Chromium Playwright при необходимости
npm run auth
npm start
```

---

## 🖥 VPS / headless запуск

Самый надёжный flow без графического окружения на сервере:

1. На домашнем ПК с браузером выполните `npm run auth`;
2. Скопируйте полученный `deepseek-auth.json` на VPS:
   ```bash
   scp deepseek-auth.json user@your-vps:/opt/deepseek-free-proxy/deepseek-auth.json
   ```
3. На VPS проверьте файл и запустите:
   ```bash
   cd /opt/deepseek-free-proxy
   chmod 600 deepseek-auth.json
   NON_INTERACTIVE=1 npm start
   ```

---

## 🦭 Rootless Podman

Контейнер предназначен только для non-interactive запуска proxy. Авторизацию
через браузер выполните на хосте командой `npm run auth`: auth-скрипты и
`deepseek-auth.json` в образ не копируются.

Запускайте Podman обычным пользователем, без `sudo`.

1. Соберите локальный образ:

```bash
podman build --format docker --tag localhost/free-deepseek-api:local --file Containerfile .
```

2. Передайте DeepSeek auth и отдельный ключ proxy через Podman secrets:

```bash
podman secret create --replace free-deepseek-auth ./deepseek-auth.json

printf 'Proxy API key: '
IFS= read -r -s PROXY_API_KEY
printf '\n'
printf '%s' "$PROXY_API_KEY" |
  podman secret create --replace free-deepseek-proxy-key -
```

Используйте длинный случайный ключ. Значение останется в переменной
`PROXY_API_KEY` текущего shell, чтобы проверить API; оно не попадает в образ или
командную строку Podman.

3. Запустите контейнер с минимальными привилегиями:

```bash
podman run --detach \
  --name free-deepseek-api \
  --publish 127.0.0.1:9655:9655 \
  --secret free-deepseek-auth,target=deepseek-auth.json,uid=1000,gid=1000,mode=0400 \
  --secret free-deepseek-proxy-key,target=proxy-api-key,uid=1000,gid=1000,mode=0400 \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  localhost/free-deepseek-api:local
```

Внутри контейнера заранее выставлены `NON_INTERACTIVE=1`, `HOST=0.0.0.0` и
пути к обоим secrets. `REQUIRE_PROXY_API_KEY=1` не даст контейнеру запуститься,
если secret с ключом отсутствует или пуст. На хосте порт публикуется только на
`127.0.0.1`; не убирайте этот адрес без отдельного сетевого firewall/access
policy.

4. Проверьте liveness, readiness аккаунта и защищённый endpoint:

```bash
podman healthcheck run free-deepseek-api
curl --fail http://127.0.0.1:9655/readyz
curl --fail \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  http://127.0.0.1:9655/v1/models
```

---

## ♻️ Session reuse и сброс чатов

FreeDeepseekAPI не создаёт новый DeepSeek-чат на каждый HTTP-запрос без причины:
- Запрос с заголовком `x-agent-session`, `session` или полем `user` привязывается к постоянной DeepSeek-сессии;
- При продолжении разговора в DeepSeek отправляются **только новые сообщения** (дельты), что предотвращает квадратичный рост контекста;
- Сессия автоматически сбрасывается при ошибках upstream, TTL, смене system prompt или изменении списка инструментов.

Управление сессиями:
```bash
# Список активных сессий
curl http://localhost:9655/v1/sessions

# Сброс конкретной сессии
curl -X POST "http://localhost:9655/reset-session?agent=my-agent"

# Сброс всех сессий
curl -X POST "http://localhost:9655/reset-session?agent=all"
```

---

## 👥 Multi-account pool

Для обхода лимитов можно подключить несколько аккаунтов DeepSeek:

```bash
mkdir -p accounts
cp deepseek-auth-1.json accounts/acc1.json
cp deepseek-auth-2.json accounts/acc2.json
chmod 600 accounts/*.json

DEEPSEEK_AUTH_DIR=./accounts npm start
```

- Новые сессии распределяются по алгоритму round-robin;
- Аккаунт закрепляется за сессией (`sticky`);
- При возникновении ошибки 429 («Too many messages») аккаунт уходит в cooldown, а запрос автоматически переключается на свободный аккаунт.

---

## ✅ Проверка работы

```bash
curl http://localhost:9655/
curl http://localhost:9655/v1/models
curl http://localhost:9655/v1/model-capabilities
```

---

## 🧪 Примеры запросов

### Chat Completions

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Привет! Ответь одним словом."}],
    "stream": false
  }'
```

### Reasoning

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-reasoner",
    "messages": [{"role": "user", "content": "Сколько букв 'р' в слове клубника?"}],
    "stream": false
  }'
```

Цепочка рассуждений возвращается в отдельном поле `choices[0].message.reasoning_content` (или в streaming delta).

### Web search

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat-search",
    "messages": [{"role": "user", "content": "Какая погода сегодня в Париже?"}],
    "stream": false
  }'
```

### Streaming

```bash
curl -N -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Расскажи короткую историю."}],
    "stream": true
  }'
```

### Anthropic Messages API

```bash
curl -X POST http://localhost:9655/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "Ответь OK"}],
    "stream": false
  }'
```

### OpenAI Responses API

```bash
curl -X POST http://localhost:9655/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "input": "Ответь OK",
    "stream": false
  }'
```

### Tool calling

FreeDeepseekAPI поддерживает OpenAI tools, Anthropic tools и Responses function tools с автоисправлением распространённых синтаксических ошибок модели (включая DSML и неэкранированные слеши).

### Мультимодальные запросы (OpenAI & Anthropic)

#### 1. OpenAI format (с внешней ссылкой на изображение)
```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-vision",
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "Что изображено на картинке?" },
          { "type": "image_url", "image_url": { "url": "https://example.com/sample.png" } }
        ]
      }
    ]
  }'
```

#### 2. OpenAI format (с Base64 data URL)
```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-vision",
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "Опиши эту диаграмму." },
          { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" } }
        ]
      }
    ]
  }'
```

#### 3. Anthropic Messages API (Vision block)
```bash
curl -X POST http://localhost:9655/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "max_tokens": 1024,
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "image",
            "source": {
              "type": "url",
              "url": "https://example.com/photo.jpg"
            }
          },
          {
            "type": "text",
            "text": "Распознай текст на этом изображении."
          }
        ]
      }
    ]
  }'
```

#### 4. Python пример (через OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:9655/v1",
    api_key="anything"
)

response = client.chat.completions.create(
    model="deepseek-vision",
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Опиши эти два изображения:"},
                {"type": "image_url", "image_url": {"url": "https://example.com/cat.jpg"}},
                {"type": "image_url", "image_url": {"url": "https://example.com/dog.jpg"}},
            ],
        }
    ],
)
print(response.choices[0].message.content)
```

---

## 🧠 Модели

`GET /v1/models` возвращает только aliases, проверенные и работающие через этот proxy.

| Alias | Глубокое мышление | Web search | Назначение |
| --- | --- | --- | --- |
| `deepseek-chat` | нет | нет | Основной chat (DeepSeek-V4.1-Flash) |
| `deepseek-reasoner` | да | нет | Режим рассуждений с `reasoning_content` |
| `deepseek-chat-search` | нет | да | Поиск в реальном времени через Web |
| `deepseek-reasoner-search` | да | да | Рассуждения + поиск |
| `deepseek-vision` | нет | нет | Мультимодальный режим распознавания изображений |
| `deepseek-r1` | да | нет | R1-совместимый alias |
| `deepseek-v4-flash` | нет | нет | Официальный API alias |
| `deepseek-v4.1-flash` | нет | нет | Актуальная web-модель чата |

---

## 🔌 Endpoints

| Method | Path | Назначение |
| --- | --- | --- |
| `GET` | `/` или `/health` | Статус proxy и готовность конфигурации |
| `GET` | `/v1/models` | Список рабочих OpenAI-compatible aliases |
| `GET` | `/v1/model-capabilities` | Полный маппинг aliases, real model, capabilities |
| `POST` | `/v1/chat/completions` | OpenAI-compatible Chat Completions (включая vision) |
| `POST` | `/v1/messages` | Anthropic Messages API shim |
| `POST` | `/v1/responses` | OpenAI Responses API shim |
| `GET` | `/v1/sessions` | Активные локальные agent sessions |
| `POST` | `/reset-session?agent=<id>` | Сбросить конкретную session |
| `POST` | `/reset-session?agent=all` | Сбросить все активные sessions |

---

## 🤖 Подключение к Hermes Agent

Hermes Agent поддерживает подключение FreeDeepseekAPI как custom OpenAI-compatible endpoint в `~/.hermes/config.yaml` (используйте значение `PROXY_API_KEY` из `.env` или `/etc/free-deepseek-api/proxy-api-key` при systemd-установке).

### Вариант 1 — Прямая настройка в секции `model:` (самый простой)

```yaml
model:
  default: "deepseek-chat"
  provider: "custom"
  base_url: "http://127.0.0.1:9655/v1"
  api_key: "YOUR_PROXY_API_KEY"
  api_mode: "chat_completions"
```

> 💡 Чтобы не хранить ключ в `config.yaml`, удалите строку `api_key:` и укажите `key_env: "DEEPSEEK_PROXY_API_KEY"`, а сам ключ пропишите в `~/.hermes/.env`: `DEEPSEEK_PROXY_API_KEY=YOUR_PROXY_API_KEY`.

### Вариант 2 — Именованный провайдер в `providers:` (выбор моделей через `/model` и Dashboard)

```yaml
providers:
  free-deepseek:
    name: "FreeDeepseekAPI"
    base_url: "http://127.0.0.1:9655/v1"
    api_key: "YOUR_PROXY_API_KEY"
    api_mode: "chat_completions"
    default_model: "deepseek-chat"
    models:
      - "deepseek-chat"
      - "deepseek-chat-search"
      - "deepseek-reasoner"
      - "deepseek-reasoner-search"

model:
  default: "deepseek-chat"
  provider: "free-deepseek"
  base_url: "http://127.0.0.1:9655/v1"
  api_mode: "chat_completions"
```

> ⚠️ **Важно:** не задавайте `provider: "deepseek"` — встроенная нормализация Hermes (`hermes_cli/model_normalize.py`) при `provider == "deepseek"` переписывает имя модели `deepseek-chat` в `deepseek-flash`. Используйте `provider: "custom"` или именованную запись в `providers:`, чтобы имя модели передавалось без изменений.

---

## 🖥 Open WebUI

Base URL для подключения в Open WebUI:

```text
http://host.docker.internal:9655/v1   # Внутри Docker контейнера
http://localhost:9655/v1               # При локальном запуске
```

API Key: любой (или ваш `PROXY_API_KEY`, если он включен в `.env`).

---

## 🔐 Обновить логин

```bash
npm run auth
```

Файлы с конфиденциальными токенами защищены через `.gitignore`:
- `deepseek-auth.json`
- `deepseek-accounts.json`
- `data/accounts/*.json`
- `.env`

---

## 🧪 Тесты

Проект содержит всесторонний набор из **165 тестов**, проверяющих синтаксис, архитектуру, безопасность, установщики, мультимодальность и CLI:

```bash
npm test
```

Результат:
```text
✔ cli tests (help, version, non-interactive, doctor, setup)
✔ doctor diagnostics tests (Node check, browser resolution, auth validation, json output)
✔ install & systemd tests (bash -n, adaptive ProtectHome, quick-install OS/distro & macOS LaunchAgent, env security)
✔ multimodal engine tests (magic byte sniffing, SSRF protection, LRU cache TTL, concurrent uploads)
✔ tool parser tests (DSML parsing, code fences, lenient JSON repair, schema compaction)
✔ account pool tests (round-robin selection, sticky sessions, cooldown handling)
✔ security tests (token leakage prevention, zero watermarks, CORS, SSRF guards)
✔ integration & unit tests (streaming, session reuse, mock server e2e)

ℹ tests 165
ℹ pass 165
ℹ fail 0
```

---

## 📌 Статус проекта

FreeDeepseekAPI — стабильный, полностью открытый локальный прокси-сервер. Все компоненты протестированы и готовы к использованию.
