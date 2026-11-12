#!/usr/bin/env bash
# FreeDeepseekAPI Systemd Service Installer for Linux
set -euo pipefail

# ANSI colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_ok() { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_err() { echo -e "${RED}[ERROR]${NC} $*"; }

# Handle --help / -h early before requiring root
for arg in "$@"; do
    if [[ "$arg" == "--help" || "$arg" == "-h" ]]; then
        echo "Использование: sudo ./deploy/install.sh [options]"
        echo "Опции:"
        echo "  --current-user       Запускать сервис от имени вызывающего пользователя (\${SUDO_USER:-\$(id -un)}) вместо freedeepseek"
        echo "  --non-interactive, -y Не задавать вопросов, использовать значения по умолчанию"
        echo "  --port=PORT          Порт прокси (по умолчанию 9655)"
        echo "  --dir=PATH           Путь к директории проекта"
        exit 0
    fi
done

# 1. Check Root / Sudo
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    log_err "Этот скрипт должен запускаться с правами root (или через sudo)."
    echo "Использование: sudo ./deploy/install.sh [опции]"
    exit 1
fi

# Detect calling user when run with sudo
REAL_USER="${SUDO_USER:-$(id -un)}"
REAL_GROUP="$(id -gn "$REAL_USER" 2>/dev/null || echo "$REAL_USER")"

# Project root: directory containing package.json and server.js
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Configurable parameters (can be overridden via environment)
PROJECT_DIR="${FREE_DEEPSEEK_DIR:-$DEFAULT_PROJECT_DIR}"
SERVICE_USER="${SERVICE_USER:-freedeepseek}"
SERVICE_GROUP="${SERVICE_GROUP:-freedeepseek}"
CONFIG_DIR="${CONFIG_DIR:-/etc/free-deepseek-api}"
SERVICE_PORT="${PORT:-9655}"
SERVICE_HOST="${HOST:-127.0.0.1}"
SERVICE_NAME="free-deepseek-api"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# Parse CLI arguments
RUN_AS_CURRENT_USER=false
NON_INTERACTIVE_INSTALL=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --current-user)
            RUN_AS_CURRENT_USER=true
            shift
            ;;
        --non-interactive|-y)
            NON_INTERACTIVE_INSTALL=true
            shift
            ;;
        --dir=*)
            PROJECT_DIR="${1#*=}"
            shift
            ;;
        --port=*)
            SERVICE_PORT="${1#*=}"
            shift
            ;;
        --help|-h)
            echo "Использование: sudo ./deploy/install.sh [options]"
            echo "Опции:"
            echo "  --current-user       Запускать сервис от имени вызывающего пользователя ($REAL_USER) вместо freedeepseek"
            echo "  --non-interactive, -y Не задавать вопросов, использовать значения по умолчанию"
            echo "  --port=PORT          Порт прокси (по умолчанию 9655)"
            echo "  --dir=PATH           Путь к директории проекта (по умолчанию: $PROJECT_DIR)"
            exit 0
            ;;
        *)
            log_err "Неизвестный параметр: $1"
            exit 1
            ;;
    esac
done

if [[ "$RUN_AS_CURRENT_USER" = true ]]; then
    SERVICE_USER="$REAL_USER"
    SERVICE_GROUP="$REAL_GROUP"
fi

log_info "=========================================================="
log_info " Установка FreeDeepseekAPI в качестве systemd сервиса     "
log_info "=========================================================="
log_info "Каталог проекта:   $PROJECT_DIR"
log_info "Пользователь:      $SERVICE_USER (группа: $SERVICE_GROUP)"
log_info "Конфигурация:      $CONFIG_DIR"
log_info "Слушать на:        $SERVICE_HOST:$SERVICE_PORT"

# 2. Check Node.js
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
    # Check common locations if not in root's PATH
    for cand in /usr/bin/node /usr/local/bin/node /home/"$REAL_USER"/.nvm/versions/node/*/bin/node; do
        if [[ -x "$cand" ]]; then
            NODE_BIN="$cand"
            break
        fi
    done
fi

if [[ -z "$NODE_BIN" ]]; then
    log_err "Node.js не найден в системе! Установите Node.js >= 18."
    exit 1
fi

NODE_VER="$("$NODE_BIN" -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VER%%.*}"
log_ok "Найден Node.js: $NODE_BIN (версия $NODE_VER)"

if [[ "$NODE_MAJOR" -lt 18 ]]; then
    log_err "Требуется Node.js >= 18.0.0, текущая версия: $NODE_VER"
    exit 1
fi
if [[ "$NODE_MAJOR" -lt 22 ]]; then
    log_warn "Для интерактивной авторизации (npm run auth / WebSocket) рекомендуется Node.js >= 22. Сервер запустится, но auth может требовать Node 22+."
fi

# 3. Create Service User and Group if needed
if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
    log_info "Создание системной группы: $SERVICE_GROUP"
    groupadd --system "$SERVICE_GROUP"
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    log_info "Создание системного пользователя: $SERVICE_USER"
    useradd --system \
        --gid "$SERVICE_GROUP" \
        --no-create-home \
        --home-dir "$PROJECT_DIR" \
        --shell /usr/sbin/nologin \
        "$SERVICE_USER"
fi

# 4. Prepare /etc/free-deepseek-api configuration directory
log_info "Подготовка каталога конфигурации $CONFIG_DIR..."
mkdir -p "$CONFIG_DIR"
chmod 0750 "$CONFIG_DIR"
chown root:"$SERVICE_GROUP" "$CONFIG_DIR"

# Generate proxy-api-key if not exists
PROXY_KEY_FILE="$CONFIG_DIR/proxy-api-key"
if [[ ! -f "$PROXY_KEY_FILE" ]]; then
    log_info "Генерация секретного PROXY_API_KEY..."
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32 > "$PROXY_KEY_FILE"
    else
        "$NODE_BIN" -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > "$PROXY_KEY_FILE"
    fi
    chmod 0640 "$PROXY_KEY_FILE"
    chown root:"$SERVICE_GROUP" "$PROXY_KEY_FILE"
    log_ok "PROXY_API_KEY создан: $PROXY_KEY_FILE"
else
    log_info "PROXY_API_KEY уже существует: $PROXY_KEY_FILE"
fi

# Ensure deepseek-auth.json placeholder or copy if exists in project
AUTH_FILE="$CONFIG_DIR/deepseek-auth.json"
if [[ ! -f "$AUTH_FILE" ]]; then
    if [[ -f "$PROJECT_DIR/deepseek-auth.json" ]]; then
        log_info "Копирование существующего deepseek-auth.json из проекта..."
        cp -p "$PROJECT_DIR/deepseek-auth.json" "$AUTH_FILE"
    else
        touch "$AUTH_FILE"
    fi
    chmod 0600 "$AUTH_FILE"
    chown "$SERVICE_USER":"$SERVICE_GROUP" "$AUTH_FILE"
fi

# Environment overrides file
ENV_FILE="$CONFIG_DIR/env"
if [[ ! -f "$ENV_FILE" ]]; then
    log_info "Создание файла окружения $ENV_FILE..."
    cat > "$ENV_FILE" <<EOF
# FreeDeepseekAPI environment overrides
HOST=$SERVICE_HOST
PORT=$SERVICE_PORT
DEEPSEEK_AUTH_PATH=$AUTH_FILE
PROXY_API_KEY_FILE=$PROXY_KEY_FILE
REQUIRE_PROXY_API_KEY=1
NON_INTERACTIVE=1
EOF
    chmod 0640 "$ENV_FILE"
    chown root:"$SERVICE_GROUP" "$ENV_FILE"
    log_ok "Создан файл окружения: $ENV_FILE"
fi

# 5. Fix permissions for project directory if dedicated user
if [[ "$SERVICE_USER" != "$REAL_USER" && "$SERVICE_USER" != "root" ]]; then
    log_info "Настройка прав доступа к директории проекта $PROJECT_DIR..."
    # The service only needs read permissions on project code
    chmod -R g+rX "$PROJECT_DIR" || true
fi

# 6. Generate and install systemd unit
log_info "Создание systemd unit файла $SERVICE_FILE..."
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=FreeDeepseekAPI (OpenAI/Anthropic-compatible proxy for DeepSeek Web)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$PROJECT_DIR
Environment=NODE_ENV=production
Environment=NON_INTERACTIVE=1
Environment=HOST=$SERVICE_HOST
Environment=PORT=$SERVICE_PORT
Environment=DEEPSEEK_AUTH_PATH=$AUTH_FILE
Environment=PROXY_API_KEY_FILE=$PROXY_KEY_FILE
Environment=REQUIRE_PROXY_API_KEY=1
EnvironmentFile=-$ENV_FILE
ExecStart=$NODE_BIN server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=15

# Security Hardening
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
SystemCallArchitectures=native
CapabilityBoundingSet=
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

chmod 0644 "$SERVICE_FILE"

# 7. Reload systemd and enable service
log_info "Перезагрузка демона systemd..."
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
log_ok "Сервис $SERVICE_NAME включен в автозагрузку."

# 8. Check auth status
AUTH_READY=false
if [[ -s "$AUTH_FILE" ]] && grep -q '"token"' "$AUTH_FILE" 2>/dev/null; then
    AUTH_READY=true
fi

echo ""
log_ok "=========================================================="
log_ok " Установка FreeDeepseekAPI завершена успешно!             "
log_ok "=========================================================="
echo ""
echo "Ключ доступа к прокси (Bearer токен):"
echo "  $(cat "$PROXY_KEY_FILE")"
echo ""

if [[ "$AUTH_READY" = true ]]; then
    log_info "Запуск сервиса..."
    systemctl restart "$SERVICE_NAME"
    sleep 1
    systemctl status "$SERVICE_NAME" --no-pager || true
else
    log_warn "Внимание: Файл авторизации DeepSeek ($AUTH_FILE) пока пуст."
    echo "Для завершения настройки выполните авторизацию или импортируйте учетные данные:"
    echo "  1) Если у вас есть cookies / JSON: sudo node $PROJECT_DIR/scripts/auth_import.js"
    echo "     или скопируйте deepseek-auth.json в $AUTH_FILE"
    echo "  2) Затем запустите сервис: sudo systemctl start $SERVICE_NAME"
fi

echo ""
echo "Управление сервисом:"
echo "  Статус:      sudo systemctl status $SERVICE_NAME"
echo "  Запуск:      sudo systemctl start $SERVICE_NAME"
echo "  Остановка:   sudo systemctl stop $SERVICE_NAME"
echo "  Перезапуск:  sudo systemctl restart $SERVICE_NAME"
echo "  Логи:        sudo journalctl -u $SERVICE_NAME -f"
echo "  Удаление:    sudo $PROJECT_DIR/deploy/uninstall.sh"
echo ""
