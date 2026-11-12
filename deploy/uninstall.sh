#!/usr/bin/env bash
# FreeDeepseekAPI Service Uninstaller (Linux systemd & macOS LaunchAgent)
set -euo pipefail

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

PURGE=false
for arg in "$@"; do
    case "$arg" in
        --purge)
            PURGE=true
            ;;
        --help|-h)
            echo "Использование: sudo ./deploy/uninstall.sh [--purge]"
            echo "  --purge    Удалить также конфигурационные файлы, ключи и системного пользователя/группу"
            exit 0
            ;;
        *)
            log_err "Неизвестный параметр: $arg"
            exit 1
            ;;
    esac
done

OS="$(uname -s)"

if [[ "$OS" == "Darwin" ]]; then
    PLIST_LABEL="com.deepseek.free-proxy"
    PLIST_PATH="${HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist"
    if [[ -f "$PLIST_PATH" ]]; then
        log_info "Выгрузка LaunchAgent $PLIST_LABEL..."
        launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || launchctl unload "$PLIST_PATH" 2>/dev/null || true
        rm -f "$PLIST_PATH"
        log_ok "LaunchAgent удален: $PLIST_PATH"
    else
        log_info "LaunchAgent не установлен ($PLIST_PATH)."
    fi
    if [[ "$PURGE" = true && -d "${HOME}/Library/Logs/deepseek-free-proxy" ]]; then
        rm -rf "${HOME}/Library/Logs/deepseek-free-proxy"
        log_ok "Логи LaunchAgent удалены."
    fi
    log_ok "Деинсталляция FreeDeepseekAPI завершена."
    exit 0
fi

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    log_err "Этот скрипт должен запускаться с правами root (или через sudo)."
    echo "Использование: sudo ./deploy/uninstall.sh [--purge]" >&2
    exit 1
fi

SERVICE_NAME="free-deepseek-api"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
CONFIG_DIR="/etc/free-deepseek-api"

if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    log_info "Остановка сервиса $SERVICE_NAME..."
    systemctl stop "$SERVICE_NAME" 2>/dev/null || true

    log_info "Отключение сервиса $SERVICE_NAME из автозагрузки..."
    systemctl disable "$SERVICE_NAME" 2>/dev/null || true
else
    log_warn "systemd не активен; пропуск команд systemctl."
fi

if [[ -f "$SERVICE_FILE" ]]; then
    log_info "Удаление unit файла $SERVICE_FILE..."
    rm -f "$SERVICE_FILE"
    if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
        systemctl daemon-reload 2>/dev/null || true
        systemctl reset-failed 2>/dev/null || true
    fi
    log_ok "Unit файл удален."
fi

if [[ "$PURGE" = true ]]; then
    if [[ -d "$CONFIG_DIR" ]]; then
        log_info "Удаление каталога конфигурации $CONFIG_DIR (--purge)..."
        rm -rf "$CONFIG_DIR"
        log_ok "Каталог $CONFIG_DIR удален."
    fi
    if id freedeepseek >/dev/null 2>&1; then
        log_info "Удаление системного пользователя freedeepseek..."
        if command -v userdel >/dev/null 2>&1; then
            userdel freedeepseek 2>/dev/null || true
        elif command -v deluser >/dev/null 2>&1; then
            deluser freedeepseek 2>/dev/null || true
        fi
    fi
    if getent group freedeepseek >/dev/null 2>&1; then
        log_info "Удаление системной группы freedeepseek..."
        if command -v groupdel >/dev/null 2>&1; then
            groupdel freedeepseek 2>/dev/null || true
        elif command -v delgroup >/dev/null 2>&1; then
            delgroup freedeepseek 2>/dev/null || true
        fi
    fi
else
    if [[ -d "$CONFIG_DIR" ]]; then
        log_info "Каталог конфигурации $CONFIG_DIR сохранен. Чтобы удалить его полностью, запустите: sudo ./deploy/uninstall.sh --purge"
    fi
fi

log_ok "Деинсталляция FreeDeepseekAPI завершена."
