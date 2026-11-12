#!/usr/bin/env bash
# FreeDeepseekAPI Systemd Service Installer for Linux
set -euo pipefail

# ANSI colors (disable when NO_COLOR is set or stdout is not a tty)
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    NC='\033[0m'
else
    RED='' GREEN='' YELLOW='' BLUE='' NC=''
fi

log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; }

print_help() {
    cat <<'EOF'
Использование: sudo ./deploy/install.sh [options]

Опции:
  --current-user          Запускать сервис от имени вызывающего пользователя (${SUDO_USER:-$(id -un)}) вместо freedeepseek
  --service-user=USER     Указать системного пользователя сервиса (по умолчанию: freedeepseek)
  --service-group=GROUP   Указать группу сервиса (по умолчанию: freedeepseek)
  --dir=PATH              Путь к существующей директории проекта
  --install-dir=PATH      Скопировать и установить проект в указанный каталог (например: /opt/deepseek-free-proxy)
  --port=PORT             Порт прокси (по умолчанию: 9655)
  --host=HOST             Хост привязки прокси (по умолчанию: 127.0.0.1)
  --protect-home=MODE     Режим systemd ProtectHome: auto | true | read-only | false (по умолчанию: auto)
  --non-interactive, -y   Не задавать вопросов, использовать значения по умолчанию
  --help, -h              Показать эту справку
EOF
}

# Handle --help / -h early before requiring root
for arg in "$@"; do
    if [[ "$arg" == "--help" || "$arg" == "-h" ]]; then
        print_help
        exit 0
    fi
done

# Helper: canonicalize path if possible
canonical_path() {
    local p="$1"
    if command -v readlink >/dev/null 2>&1; then
        readlink -f "$p" 2>/dev/null || echo "$p"
    else
        echo "$p"
    fi
}

# Helper: check whether a path (or its resolved target) resides under /home or /root
is_under_home_or_root() {
    local raw="$1"
    [[ -n "$raw" ]] || return 1
    local resolved
    resolved="$(canonical_path "$raw")"
    local candidate
    for candidate in "$raw" "$resolved"; do
        case "$candidate" in
            /home|/home/*|/root|/root/*)
                return 0
                ;;
        esac
    done
    return 1
}

# Helper: safely extract a KEY=VALUE setting from an env file without sourcing it
read_env_value() {
    local file="$1"
    local key="$2"
    [[ -f "$file" && -r "$file" ]] || return 0
    local line val
    line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" | tail -n 1 || true)"
    [[ -n "$line" ]] || return 0
    val="${line#*=}"
    # Trim surrounding whitespace and matching quotes
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    if [[ "$val" =~ ^\"(.*)\"$ ]]; then
        val="${BASH_REMATCH[1]}"
    elif [[ "$val" =~ ^\'(.*)\'$ ]]; then
        val="${BASH_REMATCH[1]}"
    else
        val="${val%% #*}"
        val="${val%"${val##*[![:space:]]}"}"
    fi
    printf '%s' "$val"
}

# Helper: safely set or update KEY=VALUE in an env file (must remain 0640 root:$SERVICE_GROUP)
upsert_env_value() {
    local file="$1"
    local key="$2"
    local val="$3"
    local tmp
    tmp="$(mktemp "${file}.tmp.XXXXXX")"
    if [[ -f "$file" ]]; then
        grep -vE "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" > "$tmp" || true
    fi
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
    chown root:"$SERVICE_GROUP" "$tmp"
    chmod 0640 "$tmp"
    mv "$tmp" "$file"
}

# Helper: execute a test/command as $SERVICE_USER
run_as_service_user() {
    if [[ "$SERVICE_USER" == "root" || "$SERVICE_USER" == "$(id -un)" ]]; then
        "$@"
        return $?
    fi
    if command -v runuser >/dev/null 2>&1; then
        runuser -u "$SERVICE_USER" -- "$@"
        return $?
    fi
    if command -v sudo >/dev/null 2>&1; then
        sudo -n -u "$SERVICE_USER" -- "$@" 2>/dev/null || sudo -u "$SERVICE_USER" -- "$@"
        return $?
    fi
    # Fallback to su (passes args after -- as $0, $1, ...)
    su -s /bin/sh "$SERVICE_USER" -c 'exec "$@"' -- "$@"
}

# Helper: find the first ancestor directory blocking traverse/read for $SERVICE_USER
find_blocking_ancestor() {
    local target="$1"
    local cur="$target"
    local lowest_fail=""
    while [[ -n "$cur" && "$cur" != "/" ]]; do
        if [[ -e "$cur" ]] && ! run_as_service_user test -x "$cur" 2>/dev/null; then
            lowest_fail="$cur"
        fi
        cur="$(dirname "$cur")"
    done
    if [[ -n "$lowest_fail" ]]; then
        local info
        info="$(stat -c '%a %U:%G' "$lowest_fail" 2>/dev/null || echo 'restricted')"
        echo "${lowest_fail} (mode/owner: ${info})"
    fi
}

# Helper: copy project runtime files cleanly to INSTALL_DIR without leaking local secrets
copy_project_to_install_dir() {
    local src="$1"
    local dst="$2"
    log_info "Копирование проекта из $src в $dst..."
    mkdir -p "$dst"
    chmod 0755 "$dst"

    if command -v tar >/dev/null 2>&1; then
        tar -C "$src" \
            --exclude='.git' \
            --exclude='.chrome-for-testing-profile*' \
            --exclude='.env' \
            --exclude='deepseek-auth.json' \
            --exclude='*.log' \
            -cf - . | tar -C "$dst" -xf -
    else
        # Fallback if tar is unavailable
        find "$src" -mindepth 1 -maxdepth 1 \
            ! -name '.git' \
            ! -name '.chrome-for-testing-profile*' \
            ! -name '.env' \
            ! -name 'deepseek-auth.json' \
            ! -name '*.log' \
            -exec cp -a {} "$dst/" \;
    fi

    # Set clean non-secret permissions readable by unprivileged service user
    chown -R root:"$SERVICE_GROUP" "$dst" 2>/dev/null || chown -R root:root "$dst"
    chmod -R a+rX "$dst"
    if [[ -d "$dst/deploy" ]]; then
        chmod 0755 "$dst"/deploy/*.sh 2>/dev/null || true
    fi
    if [[ -f "$dst/server.js" ]]; then chmod 0755 "$dst/server.js"; fi
    if [[ -f "$dst/cli.js" ]]; then chmod 0755 "$dst/cli.js"; fi
    log_ok "Файлы проекта установлены в $dst"
}

# 1. Check Root / Sudo & Systemd availability
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    log_err "Этот скрипт должен запускаться с правами root (или через sudo)."
    echo "Использование: sudo ./deploy/install.sh [опции]" >&2
    exit 1
fi

if [[ "$(uname -s)" != "Linux" ]] || ! command -v systemctl >/dev/null 2>&1 || [[ ! -d /run/systemd/system ]]; then
    log_err "systemd не активен в этой системе (возможно, контейнер Docker, WSL без systemd или macOS)."
    echo "Запускайте прокси напрямую: NON_INTERACTIVE=1 npm start (или используйте deploy/quick-install.sh)." >&2
    exit 1
fi

# Detect calling user when run with sudo
REAL_USER="${SUDO_USER:-$(id -un)}"
REAL_GROUP="$(id -gn "$REAL_USER" 2>/dev/null || echo "$REAL_USER")"

# Resolve project root cleanly even when invoked via symlink (scripts/install_service.sh)
SCRIPT_PATH="$(canonical_path "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
DEFAULT_PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Configurable parameters (can be overridden via environment or CLI flags)
PROJECT_DIR="${FREE_DEEPSEEK_DIR:-$DEFAULT_PROJECT_DIR}"
INSTALL_DIR="${INSTALL_DIR:-}"
SERVICE_USER="${SERVICE_USER:-freedeepseek}"
SERVICE_GROUP="${SERVICE_GROUP:-freedeepseek}"
CONFIG_DIR="${CONFIG_DIR:-/etc/free-deepseek-api}"
SERVICE_PORT="${PORT:-9655}"
SERVICE_HOST="${HOST:-127.0.0.1}"
PROTECT_HOME_MODE="${PROTECT_HOME:-auto}"
SERVICE_NAME="free-deepseek-api"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

PORT_EXPLICIT=false
HOST_EXPLICIT=false
RUN_AS_CURRENT_USER=false
NON_INTERACTIVE_INSTALL=false
if [[ "${NON_INTERACTIVE:-0}" =~ ^(1|true|yes|on)$ ]]; then
    NON_INTERACTIVE_INSTALL=true
fi

while [[ $# -gt 0 ]]; do
    case "$1" in
        --current-user)
            RUN_AS_CURRENT_USER=true
            shift
            ;;
        --service-user=*)
            SERVICE_USER="${1#*=}"
            shift
            ;;
        --service-user)
            [[ $# -ge 2 ]] || { log_err "Отсутствует значение для --service-user"; exit 1; }
            SERVICE_USER="$2"
            shift 2
            ;;
        --service-group=*)
            SERVICE_GROUP="${1#*=}"
            shift
            ;;
        --service-group)
            [[ $# -ge 2 ]] || { log_err "Отсутствует значение для --service-group"; exit 1; }
            SERVICE_GROUP="$2"
            shift 2
            ;;
        --non-interactive|-y)
            NON_INTERACTIVE_INSTALL=true
            shift
            ;;
        --dir=*)
            PROJECT_DIR="${1#*=}"
            shift
            ;;
        --dir)
            [[ $# -ge 2 ]] || { log_err "Отсутствует значение для --dir"; exit 1; }
            PROJECT_DIR="$2"
            shift 2
            ;;
        --install-dir=*)
            INSTALL_DIR="${1#*=}"
            shift
            ;;
        --install-dir)
            [[ $# -ge 2 ]] || { log_err "Отсутствует значение для --install-dir"; exit 1; }
            INSTALL_DIR="$2"
            shift 2
            ;;
        --port=*)
            SERVICE_PORT="${1#*=}"
            PORT_EXPLICIT=true
            shift
            ;;
        --port)
            [[ $# -ge 2 ]] || { log_err "Отсутствует значение для --port"; exit 1; }
            SERVICE_PORT="$2"
            PORT_EXPLICIT=true
            shift 2
            ;;
        --host=*)
            SERVICE_HOST="${1#*=}"
            HOST_EXPLICIT=true
            shift
            ;;
        --host)
            [[ $# -ge 2 ]] || { log_err "Отсутствует значение для --host"; exit 1; }
            SERVICE_HOST="$2"
            HOST_EXPLICIT=true
            shift 2
            ;;
        --protect-home=*)
            PROTECT_HOME_MODE="${1#*=}"
            shift
            ;;
        --protect-home)
            [[ $# -ge 2 ]] || { log_err "Отсутствует значение для --protect-home"; exit 1; }
            PROTECT_HOME_MODE="$2"
            shift 2
            ;;
        --help|-h)
            print_help
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

# Validate inputs to avoid malformed unit directives
if ! [[ "$SERVICE_PORT" =~ ^[0-9]+$ ]] || [[ "$SERVICE_PORT" -lt 1 || "$SERVICE_PORT" -gt 65535 ]]; then
    log_err "Некорректный порт: $SERVICE_PORT (ожидается 1..65535)"
    exit 1
fi
if ! [[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_.-]*\$?$ ]]; then
    log_err "Некорректное имя пользователя сервиса: $SERVICE_USER"
    exit 1
fi
if ! [[ "$SERVICE_GROUP" =~ ^[a-z_][a-z0-9_.-]*\$?$ ]]; then
    log_err "Некорректное имя группы сервиса: $SERVICE_GROUP"
    exit 1
fi
if [[ "$SERVICE_HOST" == *$'\n'* || "$SERVICE_HOST" == *$'\r'* || "$PROJECT_DIR" == *$'\n'* ]]; then
    log_err "Недопустимые символы перевода строки в параметрах."
    exit 1
fi
case "$PROTECT_HOME_MODE" in
    auto|true|read-only|false) ;;
    *)
        log_err "Некорректный режим --protect-home=$PROTECT_HOME_MODE (допустимо: auto, true, read-only, false)"
        exit 1
        ;;
esac

if [[ ! -d "$PROJECT_DIR" || ! -f "$PROJECT_DIR/server.js" ]]; then
    log_err "В директории проекта '$PROJECT_DIR' не найден server.js!"
    exit 1
fi

ORIG_SOURCE_DIR="$(cd "$PROJECT_DIR" && pwd)"
PROJECT_DIR="$ORIG_SOURCE_DIR"

# 2. Check Node.js
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
    for cand in \
        /usr/bin/node \
        /usr/local/bin/node \
        /usr/bin/nodejs \
        /snap/bin/node \
        /home/"$REAL_USER"/.nvm/versions/node/*/bin/node \
        /root/.nvm/versions/node/*/bin/node \
        /home/"$REAL_USER"/.volta/bin/node \
        /home/"$REAL_USER"/.fnm/node-versions/*/installation/bin/node; do
        if [[ -x "$cand" ]]; then
            NODE_BIN="$cand"
            break
        fi
    done
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
    log_err "Node.js не найден в системе! Установите Node.js >= 18."
    exit 1
fi

NODE_REAL_BIN="$(canonical_path "$NODE_BIN")"
NODE_VER="$("$NODE_BIN" -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VER%%.*}"
log_ok "Найден Node.js: $NODE_BIN (версия $NODE_VER)"

if [[ "$NODE_MAJOR" -lt 18 ]]; then
    log_err "Требуется Node.js >= 18.0.0, текущая версия: $NODE_VER"
    exit 1
fi
if [[ "$NODE_MAJOR" -lt 22 ]]; then
    log_warn "Для интерактивной авторизации (npm run auth / WebSocket) рекомендуется Node.js >= 22. Прокси-сервер будет работать штатно."
fi

# 3. Create Service User and Group if needed (before copying or permission checks)
ensure_service_identity() {
    if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
        log_info "Создание системной группы: $SERVICE_GROUP"
        if command -v groupadd >/dev/null 2>&1; then
            groupadd --system "$SERVICE_GROUP"
        elif command -v addgroup >/dev/null 2>&1; then
            addgroup -S "$SERVICE_GROUP"
        else
            log_err "Не найдена команда groupadd/addgroup для создания группы $SERVICE_GROUP."
            exit 1
        fi
    fi

    if ! id "$SERVICE_USER" >/dev/null 2>&1; then
        local nologin_shell="/usr/sbin/nologin"
        if [[ ! -x "$nologin_shell" ]]; then
            nologin_shell="$(command -v nologin || echo /bin/false)"
        fi
        log_info "Создание системного пользователя: $SERVICE_USER"
        if command -v useradd >/dev/null 2>&1; then
            useradd --system \
                --gid "$SERVICE_GROUP" \
                --no-create-home \
                --home-dir "$PROJECT_DIR" \
                --shell "$nologin_shell" \
                "$SERVICE_USER"
        elif command -v adduser >/dev/null 2>&1; then
            adduser -S -D -H -h "$PROJECT_DIR" -s "$nologin_shell" -G "$SERVICE_GROUP" "$SERVICE_USER"
        else
            log_err "Не найдена команда useradd/adduser для создания пользователя $SERVICE_USER."
            exit 1
        fi
    fi
}

ensure_service_identity

# 4. Handle --install-dir copy/install if requested
if [[ -n "$INSTALL_DIR" ]]; then
    mkdir -p "$INSTALL_DIR"
    INSTALL_DIR_CANON="$(cd "$INSTALL_DIR" && pwd)"
    if [[ "$(canonical_path "$INSTALL_DIR_CANON")" != "$(canonical_path "$ORIG_SOURCE_DIR")" ]]; then
        copy_project_to_install_dir "$ORIG_SOURCE_DIR" "$INSTALL_DIR_CANON"
    fi
    PROJECT_DIR="$INSTALL_DIR_CANON"
fi

# 5. Pre-flight permission check as $SERVICE_USER before touching systemd unit
preflight_project_and_node() {
    local proj_ok=true
    local node_ok=true

    if ! run_as_service_user test -d "$PROJECT_DIR" 2>/dev/null \
        || ! run_as_service_user test -x "$PROJECT_DIR" 2>/dev/null \
        || ! run_as_service_user test -r "$PROJECT_DIR/server.js" 2>/dev/null; then
        proj_ok=false
    fi

    if ! run_as_service_user test -x "$NODE_BIN" 2>/dev/null \
        || ! run_as_service_user "$NODE_BIN" -e "process.exit(0)" 2>/dev/null; then
        node_ok=false
    fi

    if [[ "$proj_ok" = true && "$node_ok" = true ]]; then
        return 0
    fi

    echo ""
    log_err "Pre-flight проверка прав от имени пользователя '$SERVICE_USER' не пройдена!"
    if [[ "$proj_ok" = false ]]; then
        local blocker
        blocker="$(find_blocking_ancestor "$PROJECT_DIR/server.js" || true)"
        log_warn "Пользователь '$SERVICE_USER' не имеет прав на вход/чтение '$PROJECT_DIR' или '$PROJECT_DIR/server.js'."
        if [[ -n "$blocker" ]]; then
            log_warn "Блокирующий родительский каталог: $blocker (это вызовет systemd status=200/CHDIR!)."
        fi
    fi
    if [[ "$node_ok" = false ]]; then
        local node_blocker
        node_blocker="$(find_blocking_ancestor "$NODE_REAL_BIN" || true)"
        log_warn "Пользователь '$SERVICE_USER' не может выполнить Node.js: $NODE_BIN (real: $NODE_REAL_BIN)."
        if [[ -n "$node_blocker" ]]; then
            log_warn "Блокирующий каталог Node.js: $node_blocker (это вызовет systemd status=203/EXEC!)."
        fi
    fi

    local can_prompt=false
    if [[ "$NON_INTERACTIVE_INSTALL" != true ]]; then
        if [[ -t 0 ]] || (: </dev/tty) 2>/dev/null; then
            can_prompt=true
        fi
    fi

    if [[ "$can_prompt" = true ]]; then
        local tty_fd="/dev/stdin"
        if [[ ! -t 0 ]]; then tty_fd="/dev/tty"; fi
        echo ""
        echo "Выберите способ устранения проблемы прав доступа:"
        if [[ "$node_ok" = true ]]; then
            echo "  1) Скопировать и установить проект в /opt/deepseek-free-proxy (рекомендуется для пользователя $SERVICE_USER)"
        fi
        echo "  2) Запускать systemd-сервис от имени текущего пользователя ($REAL_USER)"
        echo "  3) Прервать установку"
        local choice=""
        printf "Ваш выбор [1/2/3]: "
        read -r choice <"$tty_fd" || choice="3"
        case "$choice" in
            1)
                if [[ "$node_ok" = false ]]; then
                    log_err "Node.js ($NODE_REAL_BIN) всё равно недоступен для '$SERVICE_USER'. Выберите вариант 2 (--current-user) или установите Node.js системно (/usr/bin/node)."
                    exit 1
                fi
                copy_project_to_install_dir "$ORIG_SOURCE_DIR" "/opt/deepseek-free-proxy"
                PROJECT_DIR="/opt/deepseek-free-proxy"
                ;;
            2)
                SERVICE_USER="$REAL_USER"
                SERVICE_GROUP="$REAL_GROUP"
                log_info "Переключение пользователя сервиса на: $SERVICE_USER ($SERVICE_GROUP)"
                ensure_service_identity
                ;;
            *)
                log_err "Установка прервана."
                exit 1
                ;;
        esac

        # Re-verify after remediation
        if ! run_as_service_user test -d "$PROJECT_DIR" 2>/dev/null \
            || ! run_as_service_user test -x "$PROJECT_DIR" 2>/dev/null \
            || ! run_as_service_user test -r "$PROJECT_DIR/server.js" 2>/dev/null \
            || ! run_as_service_user test -x "$NODE_BIN" 2>/dev/null; then
            log_err "Повторная проверка прав для '$SERVICE_USER' не пройдена."
            exit 1
        fi
        return 0
    fi

    echo "" >&2
    echo "Рекомендуемое решение:" >&2
    if [[ "$node_ok" = true ]]; then
        echo "  1) Установите проект в системный каталог:" >&2
        echo "     sudo $ORIG_SOURCE_DIR/deploy/install.sh --install-dir=/opt/deepseek-free-proxy" >&2
    else
        echo "  1) Установите Node.js системно (например, /usr/bin/node) ИЛИ запускайте от текущего пользователя:" >&2
    fi
    echo "  2) Либо запускайте сервис от имени текущего пользователя:" >&2
    echo "     sudo $ORIG_SOURCE_DIR/deploy/install.sh --current-user" >&2
    exit 1
}

# Only adjust non-secret code permissions when the parent directory is traversable;
# never change permissions or group on .env, *auth*.json, or browser profiles.
if [[ "$SERVICE_USER" != "$REAL_USER" && "$SERVICE_USER" != "root" ]]; then
    if run_as_service_user test -x "$(dirname "$PROJECT_DIR")" 2>/dev/null; then
        log_info "Настройка прав чтения кода проекта $PROJECT_DIR для группы $SERVICE_GROUP..."
        chgrp "$SERVICE_GROUP" "$PROJECT_DIR" 2>/dev/null || true
        chmod g+rX "$PROJECT_DIR" 2>/dev/null || true
        find "$PROJECT_DIR" -mindepth 1 \
            \( -name '.env*' -o -name 'deepseek-auth*.json' -o -name '.chrome-for-testing-profile*' -o -path '*/.git*' \) -prune \
            -o -exec chgrp "$SERVICE_GROUP" {} + \
            -exec chmod g+rX {} + 2>/dev/null || true
    fi
fi

preflight_project_and_node

log_info "=========================================================="
log_info " Установка FreeDeepseekAPI в качестве systemd сервиса     "
log_info "=========================================================="
log_info "Каталог проекта:   $PROJECT_DIR"
log_info "Пользователь:      $SERVICE_USER (группа: $SERVICE_GROUP)"
log_info "Конфигурация:      $CONFIG_DIR"

# 6. Prepare /etc/free-deepseek-api configuration directory securely (no world-readable window)
log_info "Подготовка каталога конфигурации $CONFIG_DIR..."
OLD_UMASK="$(umask)"
umask 077

mkdir -p "$CONFIG_DIR"
chown root:"$SERVICE_GROUP" "$CONFIG_DIR"
chmod 0750 "$CONFIG_DIR"

PROXY_KEY_FILE="$CONFIG_DIR/proxy-api-key"
if [[ ! -s "$PROXY_KEY_FILE" ]]; then
    log_info "Генерация секретного PROXY_API_KEY..."
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32 > "$PROXY_KEY_FILE"
    else
        "$NODE_BIN" -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > "$PROXY_KEY_FILE"
    fi
    log_ok "PROXY_API_KEY создан: $PROXY_KEY_FILE"
else
    log_info "PROXY_API_KEY уже существует: $PROXY_KEY_FILE"
fi
chown root:"$SERVICE_GROUP" "$PROXY_KEY_FILE"
chmod 0640 "$PROXY_KEY_FILE"

# Ensure deepseek-auth.json exists as valid JSON ({} placeholder when empty)
AUTH_FILE="$CONFIG_DIR/deepseek-auth.json"
SRC_AUTH_CANDIDATE=""
if [[ -s "$ORIG_SOURCE_DIR/deepseek-auth.json" ]] && grep -q '"token"' "$ORIG_SOURCE_DIR/deepseek-auth.json" 2>/dev/null; then
    SRC_AUTH_CANDIDATE="$ORIG_SOURCE_DIR/deepseek-auth.json"
elif [[ -s "$PROJECT_DIR/deepseek-auth.json" ]] && grep -q '"token"' "$PROJECT_DIR/deepseek-auth.json" 2>/dev/null; then
    SRC_AUTH_CANDIDATE="$PROJECT_DIR/deepseek-auth.json"
fi

if [[ ! -f "$AUTH_FILE" ]]; then
    if [[ -n "$SRC_AUTH_CANDIDATE" ]]; then
        log_info "Копирование существующего deepseek-auth.json в $AUTH_FILE..."
        cp "$SRC_AUTH_CANDIDATE" "$AUTH_FILE"
    else
        log_info "Создание placeholder-файла авторизации ($AUTH_FILE -> {})..."
        printf '{}\n' > "$AUTH_FILE"
    fi
elif [[ ! -s "$AUTH_FILE" ]] || [[ -z "$(tr -d '[:space:]' < "$AUTH_FILE")" ]]; then
    if [[ -n "$SRC_AUTH_CANDIDATE" ]]; then
        log_info "Обновление пустого $AUTH_FILE из $SRC_AUTH_CANDIDATE..."
        cp "$SRC_AUTH_CANDIDATE" "$AUTH_FILE"
    else
        log_warn "Обнаружен 0-байтовый $AUTH_FILE — запись валидного JSON placeholder {}..."
        printf '{}\n' > "$AUTH_FILE"
    fi
fi
chown "$SERVICE_USER":"$SERVICE_GROUP" "$AUTH_FILE"
chmod 0600 "$AUTH_FILE"

# Validate JSON syntax of AUTH_FILE safely (passing path as argv[1])
if ! "$NODE_BIN" -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "$AUTH_FILE" 2>/dev/null; then
    log_warn "Файл $AUTH_FILE содержит некорректный JSON — сервис может не загрузить аккаунт до исправления файла."
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
    log_ok "Создан файл окружения: $ENV_FILE"
else
    if [[ "$PORT_EXPLICIT" = true ]]; then
        upsert_env_value "$ENV_FILE" "PORT" "$SERVICE_PORT"
    fi
    if [[ "$HOST_EXPLICIT" = true ]]; then
        upsert_env_value "$ENV_FILE" "HOST" "$SERVICE_HOST"
    fi
fi
chown root:"$SERVICE_GROUP" "$ENV_FILE"
chmod 0640 "$ENV_FILE"

umask "$OLD_UMASK"

# Determine effective runtime configuration (ENV_FILE overrides unit defaults)
EFF_HOST="$(read_env_value "$ENV_FILE" "HOST")"
EFF_PORT="$(read_env_value "$ENV_FILE" "PORT")"
EFF_AUTH_PATH="$(read_env_value "$ENV_FILE" "DEEPSEEK_AUTH_PATH")"
EFF_AUTH_DIR="$(read_env_value "$ENV_FILE" "DEEPSEEK_AUTH_DIR")"
EFF_KEY_FILE="$(read_env_value "$ENV_FILE" "PROXY_API_KEY_FILE")"

EFF_HOST="${EFF_HOST:-$SERVICE_HOST}"
EFF_PORT="${EFF_PORT:-$SERVICE_PORT}"
EFF_AUTH_PATH="${EFF_AUTH_PATH:-$AUTH_FILE}"
EFF_KEY_FILE="${EFF_KEY_FILE:-$PROXY_KEY_FILE}"

log_info "Слушать на:        $EFF_HOST:$EFF_PORT"

# Verify $SERVICE_USER can actually read all effective config/secret files
PREFLIGHT_FILES=("$EFF_KEY_FILE")
if [[ -n "$EFF_AUTH_DIR" ]]; then
    PREFLIGHT_FILES+=("$EFF_AUTH_DIR")
else
    IFS=',' read -r -a _auth_list <<< "$EFF_AUTH_PATH"
    for _ap in "${_auth_list[@]}"; do
        _ap="${_ap#"${_ap%%[![:space:]]*}"}"
        _ap="${_ap%"${_ap##*[![:space:]]}"}"
        [[ -n "$_ap" ]] && PREFLIGHT_FILES+=("$_ap")
    done
fi

for _pf in "${PREFLIGHT_FILES[@]}"; do
    if [[ -e "$_pf" ]] && ! run_as_service_user test -r "$_pf" 2>/dev/null; then
        log_err "Пользователь '$SERVICE_USER' не имеет прав на чтение '$_pf'!"
        _blk="$(find_blocking_ancestor "$_pf" || true)"
        [[ -n "$_blk" ]] && log_warn "Блокирующий каталог: $_blk"
        exit 1
    fi
done

# 7. Compute Adaptive ProtectHome
PROTECT_HOME="$PROTECT_HOME_MODE"
if [[ "$PROTECT_HOME" == "auto" ]]; then
    PROTECT_HOME="true"
    PATHS_TO_CHECK=(
        "$PROJECT_DIR"
        "$NODE_BIN"
        "$NODE_REAL_BIN"
        "$CONFIG_DIR"
        "$ENV_FILE"
        "$EFF_KEY_FILE"
        "$(dirname "$EFF_KEY_FILE")"
    )
    if [[ -n "$EFF_AUTH_DIR" ]]; then
        PATHS_TO_CHECK+=("$EFF_AUTH_DIR")
    fi
    IFS=',' read -r -a _auth_list2 <<< "$EFF_AUTH_PATH"
    for _ap in "${_auth_list2[@]}"; do
        _ap="${_ap#"${_ap%%[![:space:]]*}"}"
        _ap="${_ap%"${_ap##*[![:space:]]}"}"
        if [[ -n "$_ap" ]]; then
            PATHS_TO_CHECK+=("$_ap" "$(dirname "$_ap")")
        fi
    done

    for _chk in "${PATHS_TO_CHECK[@]}"; do
        if is_under_home_or_root "$_chk"; then
            PROTECT_HOME="read-only"
            log_info "Путь '$_chk' находится в /home или /root -> установлен ProtectHome=read-only (защита от 200/CHDIR)"
            break
        fi
    done
fi
log_info "ProtectHome:       $PROTECT_HOME"

# Format ExecStart cleanly (quote paths if they contain whitespace)
if [[ "$NODE_BIN" == *" "* || "$PROJECT_DIR" == *" "* ]]; then
    EXEC_START_LINE="\"$NODE_BIN\" \"$PROJECT_DIR/server.js\""
else
    EXEC_START_LINE="$NODE_BIN $PROJECT_DIR/server.js"
fi

# 8. Generate and install systemd unit
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
ExecStart=$EXEC_START_LINE
Restart=on-failure
RestartSec=5
TimeoutStopSec=15

# Security Hardening
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=$PROTECT_HOME
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

# 9. Reload systemd, enable, start/restart, and verify status + /health
log_info "Перезагрузка демона systemd и запуск сервиса..."
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# Verify service is active (brief retry loop while Node boots)
SVC_ACTIVE=false
for _i in 1 2 3 4 5 6 7 8 9 10; do
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        SVC_ACTIVE=true
        break
    fi
    sleep 0.5
done

# Determine probe host for /health check (map wildcard bind addresses to loopback)
PROBE_HOST="$EFF_HOST"
case "$PROBE_HOST" in
    0.0.0.0|"*"|"") PROBE_HOST="127.0.0.1" ;;
    "::"|"[::]")    PROBE_HOST="[::1]" ;;
    *:*)
        if [[ "$PROBE_HOST" != \[*\] ]]; then
            PROBE_HOST="[${PROBE_HOST}]"
        fi
        ;;
esac
HEALTH_URL="http://${PROBE_HOST}:${EFF_PORT}/health"

HEALTH_OK=false
if [[ "$SVC_ACTIVE" = true ]]; then
    for _i in 1 2 3 4 5 6 7 8 9 10 11 12; do
        if command -v curl >/dev/null 2>&1; then
            if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
                HEALTH_OK=true
                break
            fi
        else
            if "$NODE_BIN" -e "fetch(process.argv[1], { signal: AbortSignal.timeout(2000) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" "$HEALTH_URL" 2>/dev/null; then
                HEALTH_OK=true
                break
            fi
        fi
        sleep 0.5
    done
fi

echo ""
systemctl status "$SERVICE_NAME" --no-pager || true
echo ""

if [[ "$SVC_ACTIVE" != true || "$HEALTH_OK" != true ]]; then
    log_err "Сервис $SERVICE_NAME не запустился или не прошёл проверку $HEALTH_URL!"
    log_err "Последние 20 строк журнала (journalctl -u $SERVICE_NAME -n 20):"
    journalctl -u "$SERVICE_NAME" -n 20 --no-pager || true
    exit 1
fi

log_ok "Проверка здоровья пройдена: $HEALTH_URL (HTTP 200)"

# Check whether DeepSeek credentials are already populated
AUTH_READY=false
if [[ -s "$AUTH_FILE" ]] && grep -q '"token"' "$AUTH_FILE" 2>/dev/null; then
    AUTH_READY=true
fi

echo ""
log_ok "=========================================================="
log_ok " Установка FreeDeepseekAPI завершена успешно!             "
log_ok "=========================================================="
echo ""
echo "Ключ доступа к прокси (Bearer токен из $PROXY_KEY_FILE):"
echo "  $(cat "$PROXY_KEY_FILE")"
echo ""

if [[ "$AUTH_READY" != true ]]; then
    log_warn "Файл авторизации DeepSeek ($AUTH_FILE) пока содержит пустой шаблон '{}'."
    echo "Сервис запущен и отвечает на /health, но для запросов к чату добавьте учетные данные:"
    echo "  1) Импортируйте cookies/JSON: sudo $NODE_BIN $PROJECT_DIR/scripts/auth_import.js --input ./deepseek-auth.json --output $AUTH_FILE"
    echo "     или скопируйте рабочий deepseek-auth.json в $AUTH_FILE (chmod 0600, chown $SERVICE_USER:$SERVICE_GROUP)"
    echo "  2) Затем перезапустите сервис: sudo systemctl restart $SERVICE_NAME"
    echo ""
fi

echo "Управление сервисом:"
echo "  Статус:      sudo systemctl status $SERVICE_NAME"
echo "  Запуск:      sudo systemctl start $SERVICE_NAME"
echo "  Остановка:   sudo systemctl stop $SERVICE_NAME"
echo "  Перезапуск:  sudo systemctl restart $SERVICE_NAME"
echo "  Логи:        sudo journalctl -u $SERVICE_NAME -f"
echo "  Удаление:    sudo $PROJECT_DIR/deploy/uninstall.sh"
echo ""
