#!/usr/bin/env bash
# FreeDeepseekAPI Systemd Service Uninstaller for Linux
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_ok() { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_err() { echo -e "${RED}[ERROR]${NC} $*"; }

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    log_err "Этот скрипт должен запускаться с правами root (или через sudo)."
    echo "Использование: sudo ./deploy/uninstall.sh [--purge]"
    exit 1
fi

SERVICE_NAME="free-deepseek-api"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
CONFIG_DIR="/etc/free-deepseek-api"
PURGE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --purge)
            PURGE=true
            shift
            ;;
        --help|-h)
            echo "Использование: sudo ./deploy/uninstall.sh [--purge]"
            echo "  --purge    Удалить также конфигурационные файлы и ключи ($CONFIG_DIR)"
            exit 0
            ;;
        *)
            log_err "Неизвестный параметр: $1"
            exit 1
            ;;
    esac
done

log_info "Остановка сервиса $SERVICE_NAME..."
systemctl stop "$SERVICE_NAME" 2>/dev/null || true

log_info "Отключение сервиса $SERVICE_NAME из автозагрузки..."
systemctl disable "$SERVICE_NAME" 2>/dev/null || true

if [[ -f "$SERVICE_FILE" ]]; then
    log_info "Удаление unit файла $SERVICE_FILE..."
    rm -f "$SERVICE_FILE"
    systemctl daemon-reload
    systemctl reset-failed 2>/dev/null || true
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
        userdel freedeepseek 2>/dev/null || true
    fi
else
    if [[ -d "$CONFIG_DIR" ]]; then
        log_info "Каталог конфигурации $CONFIG_DIR сохранен. Чтобы удалить его полностью, запустите: sudo ./deploy/uninstall.sh --purge"
    fi
fi

log_ok "Деинсталляция FreeDeepseekAPI завершена."
