#!/usr/bin/env bash
# FreeDeepseekAPI Cross-Platform One-Line Installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/clockwork-dev/deepseek-free-proxy/main/deploy/quick-install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/clockwork-dev/deepseek-free-proxy/main/deploy/quick-install.sh | NON_INTERACTIVE=1 bash
#   curl -fsSL https://raw.githubusercontent.com/clockwork-dev/deepseek-free-proxy/main/deploy/quick-install.sh | bash -s -- --port=9655
set -euo pipefail

main() {
    # ------------------------------------------------------------------
    # Colors & logging
    # ------------------------------------------------------------------
    local RED='' GREEN='' YELLOW='' BLUE='' BOLD='' NC=''
    if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
        RED='\033[0;31m'
        GREEN='\033[0;32m'
        YELLOW='\033[1;33m'
        BLUE='\033[0;34m'
        BOLD='\033[1m'
        NC='\033[0m'
    fi

    log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
    log_ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
    log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
    log_err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; }

    # ------------------------------------------------------------------
    # Configuration & CLI flags (env vars or bash -s -- flags)
    # ------------------------------------------------------------------
    local REPO_URL="${REPO_URL:-https://github.com/clockwork-dev/deepseek-free-proxy.git}"
    local REPO_BRANCH="${REPO_BRANCH:-${BRANCH:-main}}"
    local INSTALL_DIR="${INSTALL_DIR:-}"
    local PORT="${PORT:-9655}"
    local HOST="${HOST:-127.0.0.1}"
    local NON_INTERACTIVE="${NON_INTERACTIVE:-0}"
    local CURRENT_USER="${CURRENT_USER:-0}"
    local INSTALL_BROWSER="${INSTALL_BROWSER:-}"
    local SKIP_SERVICE="${SKIP_SERVICE:-0}"
    local USER_DIR_MODE=false

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --install-dir=*)
                INSTALL_DIR="${1#*=}"
                shift
                ;;
            --install-dir)
                [[ $# -ge 2 ]] || { log_err "Missing value for --install-dir"; exit 1; }
                INSTALL_DIR="$2"
                shift 2
                ;;
            --repo=*)
                REPO_URL="${1#*=}"
                shift
                ;;
            --branch=*)
                REPO_BRANCH="${1#*=}"
                shift
                ;;
            --port=*)
                PORT="${1#*=}"
                shift
                ;;
            --port)
                [[ $# -ge 2 ]] || { log_err "Missing value for --port"; exit 1; }
                PORT="$2"
                shift 2
                ;;
            --host=*)
                HOST="${1#*=}"
                shift
                ;;
            --host)
                [[ $# -ge 2 ]] || { log_err "Missing value for --host"; exit 1; }
                HOST="$2"
                shift 2
                ;;
            --non-interactive|-y)
                NON_INTERACTIVE=1
                shift
                ;;
            --current-user)
                CURRENT_USER=1
                shift
                ;;
            --user-dir)
                USER_DIR_MODE=true
                shift
                ;;
            --install-browser)
                INSTALL_BROWSER=1
                shift
                ;;
            --skip-browser)
                INSTALL_BROWSER=0
                shift
                ;;
            --skip-service)
                SKIP_SERVICE=1
                shift
                ;;
            --help|-h)
                cat <<EOF
FreeDeepseekAPI Quick Installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/clockwork-dev/deepseek-free-proxy/main/deploy/quick-install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/clockwork-dev/deepseek-free-proxy/main/deploy/quick-install.sh | bash -s -- [options]

Options:
  --install-dir=PATH      Target directory (default: /opt/deepseek-free-proxy on root/Linux, ~/deepseek-free-proxy on macOS/non-root)
  --port=PORT             Proxy HTTP port (default: 9655)
  --host=HOST             Proxy bind host (default: 127.0.0.1)
  --current-user          Run Linux systemd service as current user instead of freedeepseek
  --user-dir              Install into ~/deepseek-free-proxy even when sudo is available
  --install-browser       Install Chromium via Playwright for local login capture
  --skip-browser          Skip Chromium check/installation
  --skip-service          Skip systemd / LaunchAgent service setup (foreground setup only)
  --non-interactive, -y   Run without prompts (default when stdin is piped without /dev/tty)
  --branch=BRANCH         Git branch to install (default: main)
  --help, -h              Show this help
EOF
                exit 0
                ;;
            *)
                log_err "Unknown option: $1"
                exit 1
                ;;
        esac
    done

    # Validate basic numeric port
    if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [[ "$PORT" -lt 1 || "$PORT" -gt 65535 ]]; then
        log_err "Invalid PORT: $PORT (expected 1..65535)"
        exit 1
    fi

    local IS_NON_INTERACTIVE=false
    if [[ "$NON_INTERACTIVE" =~ ^(1|true|yes|on)$ ]]; then
        IS_NON_INTERACTIVE=true
    fi

    # Detect whether interactive prompts via /dev/tty are actually possible
    local HAS_TTY=false
    if [[ "$IS_NON_INTERACTIVE" != true && -t 1 ]] && (: </dev/tty) 2>/dev/null; then
        HAS_TTY=true
    fi

    prompt_tty_yes_no() {
        local question="$1"
        local default_ans="${2:-n}"
        if [[ "$HAS_TTY" != true ]]; then
            [[ "$default_ans" == "y" ]]
            return $?
        fi
        local hint="[y/N]"
        [[ "$default_ans" == "y" ]] && hint="[Y/n]"
        local ans=""
        printf "%s %s: " "$question" "$hint" >/dev/tty
        read -r ans </dev/tty || ans=""
        ans="$(printf '%s' "$ans" | tr '[:upper:]' '[:lower:]')"
        if [[ -z "$ans" ]]; then
            [[ "$default_ans" == "y" ]]
            return $?
        fi
        [[ "$ans" == "y" || "$ans" == "yes" ]]
    }

    # ------------------------------------------------------------------
    # OS, Distro, Init System, Container & WSL Detection
    # ------------------------------------------------------------------
    local OS_RAW OS_FAMILY DISTRO_ID DISTRO_LIKE PKG_MGR=""
    OS_RAW="$(uname -s)"
    case "$OS_RAW" in
        Linux)   OS_FAMILY="linux" ;;
        Darwin)  OS_FAMILY="darwin" ;;
        MINGW*|MSYS*|CYGWIN*)
            log_err "Detected Windows shell ($OS_RAW). Please install Node.js >= 18 natively or run inside WSL2."
            echo "Windows setup: git clone $REPO_URL && cd deepseek-free-proxy && npm install --omit=dev && npm run setup" >&2
            exit 1
            ;;
        *)
            log_err "Unsupported OS: $OS_RAW"
            exit 1
            ;;
    esac

    local IS_WSL=false
    local IS_CONTAINER=false
    local SYSTEMD_ACTIVE=false

    if [[ "$OS_FAMILY" == "linux" ]]; then
        if [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
            IS_WSL=true
        fi
        if [[ -f /.dockerenv || -f /run/.containerenv ]] || grep -qaE 'container=' /proc/1/environ 2>/dev/null; then
            IS_CONTAINER=true
        fi
        if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
            SYSTEMD_ACTIVE=true
        fi

        DISTRO_ID="unknown"
        DISTRO_LIKE=""
        if [[ -r /etc/os-release ]]; then
            # Safely parse ID and ID_LIKE without sourcing arbitrary code
            DISTRO_ID="$(grep -E '^ID=' /etc/os-release | head -n 1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr '[:upper:]' '[:lower:]' || echo unknown)"
            DISTRO_LIKE="$(grep -E '^ID_LIKE=' /etc/os-release | head -n 1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr '[:upper:]' '[:lower:]' || echo "")"
        fi

        case " $DISTRO_ID $DISTRO_LIKE " in
            *" debian "*|*" ubuntu "*|*" linuxmint "*|*" pop "*|*" raspbian "*|*" kali "*|*" armbian "*)
                PKG_MGR="apt" ;;
            *" fedora "*|*" rhel "*|*" centos "*|*" rocky "*|*" almalinux "*|*" ol "*|*" amzn "*)
                if command -v dnf >/dev/null 2>&1; then PKG_MGR="dnf"; else PKG_MGR="yum"; fi ;;
            *" arch "*|*" manjaro "*|*" endeavouros "*)
                PKG_MGR="pacman" ;;
            *" alpine "*)
                PKG_MGR="apk" ;;
            *" opensuse"*|*" sles "*|*" suse "*)
                PKG_MGR="zypper" ;;
            *)
                if command -v apt-get >/dev/null 2>&1; then PKG_MGR="apt"
                elif command -v dnf >/dev/null 2>&1; then PKG_MGR="dnf"
                elif command -v yum >/dev/null 2>&1; then PKG_MGR="yum"
                elif command -v pacman >/dev/null 2>&1; then PKG_MGR="pacman"
                elif command -v apk >/dev/null 2>&1; then PKG_MGR="apk"
                elif command -v zypper >/dev/null 2>&1; then PKG_MGR="zypper"
                fi
                ;;
        esac
    elif [[ "$OS_FAMILY" == "darwin" ]]; then
        PKG_MGR="brew"
    fi

    # Sudo helper for Linux
    local SUDO="" CAN_PRIV_ESCALATE=false
    if [[ "$OS_FAMILY" == "linux" ]]; then
        if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
            CAN_PRIV_ESCALATE=true
        elif command -v sudo >/dev/null 2>&1; then
            if sudo -n true 2>/dev/null || [[ "$HAS_TTY" == true ]]; then
                SUDO="sudo"
                CAN_PRIV_ESCALATE=true
            fi
        fi
    fi

    log_info "${BOLD}FreeDeepseekAPI Quick Installer${NC}"
    log_info "Platform: $OS_RAW ($OS_FAMILY${DISTRO_ID:+, distro=$DISTRO_ID}${PKG_MGR:+, pkg=$PKG_MGR}${IS_WSL:+, wsl=$IS_WSL}${IS_CONTAINER:+, container=$IS_CONTAINER})"
    if [[ "$OS_FAMILY" == "linux" ]]; then
        log_info "Systemd active: $SYSTEMD_ACTIVE"
    fi

    # ------------------------------------------------------------------
    # Resolve default INSTALL_DIR
    # ------------------------------------------------------------------
    if [[ -z "$INSTALL_DIR" ]]; then
        if [[ "$OS_FAMILY" == "darwin" || "$USER_DIR_MODE" == true ]]; then
            INSTALL_DIR="$HOME/deepseek-free-proxy"
        elif [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
            INSTALL_DIR="/opt/deepseek-free-proxy"
        elif [[ "$SYSTEMD_ACTIVE" == true && "$CAN_PRIV_ESCALATE" == true && "$SKIP_SERVICE" != "1" ]]; then
            INSTALL_DIR="/opt/deepseek-free-proxy"
        else
            INSTALL_DIR="$HOME/deepseek-free-proxy"
        fi
    fi
    log_info "Install directory: $INSTALL_DIR"

    # ------------------------------------------------------------------
    # Dependency checks & installation: curl, git, nodejs >= 18, npm
    # ------------------------------------------------------------------
    node_major_version() {
        local bin="${1:-$(command -v node || true)}"
        if [[ -z "$bin" || ! -x "$bin" ]]; then
            echo 0
            return
        fi
        local ver
        ver="$("$bin" -v 2>/dev/null | sed 's/^v//' || echo 0)"
        echo "${ver%%.*}"
    }

    install_node_tarball_linux() {
        local arch uname_m node_arch ver="v22.14.0"
        uname_m="$(uname -m)"
        case "$uname_m" in
            x86_64|amd64) node_arch="x64" ;;
            aarch64|arm64) node_arch="arm64" ;;
            armv7l) node_arch="armv7l" ;;
            *)
                log_err "Unsupported architecture for Node.js binary fallback: $uname_m"
                return 1
                ;;
        esac
        local url="https://nodejs.org/dist/${ver}/node-${ver}-linux-${node_arch}.tar.xz"
        local tmpdir
        tmpdir="$(mktemp -d)"
        log_info "Installing Node.js ${ver} (${node_arch}) into /usr/local..."
        if curl -fsSL "$url" -o "$tmpdir/node.tar.xz"; then
            $SUDO tar -xJf "$tmpdir/node.tar.xz" -C /usr/local --strip-components=1
            rm -rf "$tmpdir"
            return 0
        fi
        rm -rf "$tmpdir"
        return 1
    }

    ensure_linux_deps() {
        local need_curl=false need_git=false need_node=false need_npm=false
        command -v curl >/dev/null 2>&1 || need_curl=true
        command -v git  >/dev/null 2>&1 || need_git=true
        local nmajor
        nmajor="$(node_major_version)"
        if [[ "$nmajor" -lt 18 ]]; then need_node=true; fi
        command -v npm >/dev/null 2>&1 || need_npm=true

        if [[ "$need_curl" == false && "$need_git" == false && "$need_node" == false && "$need_npm" == false ]]; then
            return 0
        fi

        if [[ "$CAN_PRIV_ESCALATE" != true ]]; then
            log_err "Missing prerequisites (curl/git/nodejs>=18/npm) and no root/sudo privileges available to install them."
            echo "Install curl, git, nodejs (>=18), and npm using your system package manager, then re-run." >&2
            exit 1
        fi

        log_info "Installing missing prerequisites (pkg manager: ${PKG_MGR:-unknown})..."

        case "$PKG_MGR" in
            apt)
                $SUDO apt-get update -qq
                local apt_pkgs=("ca-certificates")
                [[ "$need_curl" == true ]] && apt_pkgs+=("curl")
                [[ "$need_git" == true ]]  && apt_pkgs+=("git")
                DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq "${apt_pkgs[@]}"

                if [[ "$need_node" == true || "$need_npm" == true ]]; then
                    local cand_ver cand_major=0
                    cand_ver="$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/ {print $2}' | sed 's/^[0-9]*://' | cut -d- -f1 || true)"
                    if [[ "$cand_ver" =~ ^[0-9]+ ]]; then
                        cand_major="${cand_ver%%.*}"
                    fi
                    if [[ "$cand_major" -ge 18 ]]; then
                        DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq nodejs npm
                    else
                        log_info "Distro nodejs candidate (${cand_ver:-none}) < 18; installing Node.js 22 LTS..."
                        if curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash - >/dev/null 2>&1; then
                            DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq nodejs
                        else
                            DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq xz-utils || true
                            install_node_tarball_linux
                        fi
                    fi
                fi
                ;;
            dnf|yum)
                local rpm_pkgs=("ca-certificates")
                [[ "$need_curl" == true ]] && rpm_pkgs+=("curl")
                [[ "$need_git" == true ]]  && rpm_pkgs+=("git")
                $SUDO "$PKG_MGR" install -y "${rpm_pkgs[@]}"

                if [[ "$need_node" == true || "$need_npm" == true ]]; then
                    $SUDO "$PKG_MGR" install -y nodejs npm 2>/dev/null || true
                    if [[ "$(node_major_version)" -lt 18 ]] || ! command -v npm >/dev/null 2>&1; then
                        log_info "Distro nodejs < 18 or missing npm; installing Node.js 22 LTS..."
                        if curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO bash - >/dev/null 2>&1; then
                            $SUDO "$PKG_MGR" install -y nodejs
                        else
                            $SUDO "$PKG_MGR" install -y xz || true
                            install_node_tarball_linux
                        fi
                    fi
                fi
                ;;
            pacman)
                local arch_pkgs=("ca-certificates")
                [[ "$need_curl" == true ]] && arch_pkgs+=("curl")
                [[ "$need_git" == true ]]  && arch_pkgs+=("git")
                [[ "$need_node" == true || "$need_npm" == true ]] && arch_pkgs+=("nodejs" "npm")
                $SUDO pacman -Sy --noconfirm --needed "${arch_pkgs[@]}"
                ;;
            apk)
                local apk_pkgs=("ca-certificates" "bash")
                [[ "$need_curl" == true ]] && apk_pkgs+=("curl")
                [[ "$need_git" == true ]]  && apk_pkgs+=("git")
                [[ "$need_node" == true || "$need_npm" == true ]] && apk_pkgs+=("nodejs" "npm")
                $SUDO apk add --no-cache "${apk_pkgs[@]}"
                ;;
            zypper)
                $SUDO zypper --non-interactive refresh
                local zyp_pkgs=("ca-certificates")
                [[ "$need_curl" == true ]] && zyp_pkgs+=("curl")
                [[ "$need_git" == true ]]  && zyp_pkgs+=("git")
                $SUDO zypper --non-interactive install -y "${zyp_pkgs[@]}"
                if [[ "$need_node" == true || "$need_npm" == true ]]; then
                    $SUDO zypper --non-interactive install -y nodejs22 npm22 2>/dev/null \
                        || $SUDO zypper --non-interactive install -y nodejs20 npm20 2>/dev/null \
                        || $SUDO zypper --non-interactive install -y nodejs npm 2>/dev/null \
                        || true
                    if [[ "$(node_major_version)" -lt 18 ]] || ! command -v npm >/dev/null 2>&1; then
                        $SUDO zypper --non-interactive install -y xz || true
                        install_node_tarball_linux
                    fi
                fi
                ;;
            *)
                log_err "Unsupported package manager. Please manually install curl, git, nodejs >= 18, and npm."
                exit 1
                ;;
        esac
    }

    ensure_macos_deps() {
        # Locate brew even if not yet on PATH
        if ! command -v brew >/dev/null 2>&1; then
            if [[ -x /opt/homebrew/bin/brew ]]; then
                eval "$(/opt/homebrew/bin/brew shellenv)"
            elif [[ -x /usr/local/bin/brew ]]; then
                eval "$(/usr/local/bin/brew shellenv)"
            fi
        fi

        if ! command -v brew >/dev/null 2>&1; then
            if [[ "$HAS_TTY" == true ]] && prompt_tty_yes_no "Homebrew is not installed. Install Homebrew now?" "y"; then
                NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
                if [[ -x /opt/homebrew/bin/brew ]]; then eval "$(/opt/homebrew/bin/brew shellenv)"
                elif [[ -x /usr/local/bin/brew ]]; then eval "$(/usr/local/bin/brew shellenv)"
                fi
            else
                log_err "Homebrew is required on macOS when git or Node.js >= 18 is missing."
                echo 'Install Homebrew first: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' >&2
                exit 1
            fi
        fi

        # Check git without triggering macOS Xcode CLT GUI popup if stubbed
        if ! xcode-select -p >/dev/null 2>&1 && [[ ! -x /opt/homebrew/bin/git && ! -x /usr/local/bin/git ]]; then
            log_info "Installing git via Homebrew..."
            brew install git
        elif ! command -v git >/dev/null 2>&1; then
            log_info "Installing git via Homebrew..."
            brew install git
        fi

        local nmajor
        nmajor="$(node_major_version)"
        if [[ "$nmajor" -lt 18 ]] || ! command -v npm >/dev/null 2>&1; then
            log_info "Installing/upgrading Node.js via Homebrew..."
            if brew list node >/dev/null 2>&1; then
                brew upgrade node || brew install node
            else
                brew install node
            fi
        fi
    }

    if [[ "$OS_FAMILY" == "linux" ]]; then
        ensure_linux_deps
    elif [[ "$OS_FAMILY" == "darwin" ]]; then
        ensure_macos_deps
    fi

    # Final verification of core dependencies
    for req_cmd in curl git node npm; do
        if ! command -v "$req_cmd" >/dev/null 2>&1; then
            log_err "Required command '$req_cmd' is still missing after setup."
            exit 1
        fi
    done

    local NODE_BIN NODE_VER NODE_MAJOR
    NODE_BIN="$(command -v node)"
    NODE_VER="$("$NODE_BIN" -v | sed 's/^v//')"
    NODE_MAJOR="${NODE_VER%%.*}"
    if [[ "$NODE_MAJOR" -lt 18 ]]; then
        log_err "Node.js >= 18 is required, found v$NODE_VER at $NODE_BIN"
        exit 1
    fi
    log_ok "Dependencies ready: git, curl, npm, node v$NODE_VER ($NODE_BIN)"

    # ------------------------------------------------------------------
    # Clone or safely update repository, preserving .env & deepseek-auth.json
    # ------------------------------------------------------------------
    local BACKUP_DIR
    BACKUP_DIR="$(mktemp -d)"
    trap 'rm -rf "$BACKUP_DIR"' EXIT

    backup_user_files() {
        local target="$1"
        if [[ -f "$target/.env" ]]; then
            cp -p "$target/.env" "$BACKUP_DIR/.env"
            chmod 0600 "$BACKUP_DIR/.env"
        fi
        if [[ -f "$target/deepseek-auth.json" ]]; then
            cp -p "$target/deepseek-auth.json" "$BACKUP_DIR/deepseek-auth.json"
            chmod 0600 "$BACKUP_DIR/deepseek-auth.json"
        fi
    }

    restore_user_files() {
        local target="$1"
        if [[ -f "$BACKUP_DIR/.env" && ! -f "$target/.env" ]]; then
            cp -p "$BACKUP_DIR/.env" "$target/.env"
            chmod 0600 "$target/.env"
        fi
        if [[ -f "$BACKUP_DIR/deepseek-auth.json" && ! -f "$target/deepseek-auth.json" ]]; then
            cp -p "$BACKUP_DIR/deepseek-auth.json" "$target/deepseek-auth.json"
            chmod 0600 "$target/deepseek-auth.json"
        fi
    }

    ensure_dir_writable() {
        local dir="$1"
        if [[ -d "$dir" ]]; then
            if [[ -w "$dir" ]]; then return 0; fi
        else
            local parent
            parent="$(dirname "$dir")"
            if [[ -d "$parent" && -w "$parent" ]]; then
                mkdir -p "$dir"
                return 0
            fi
        fi

        if [[ "$CAN_PRIV_ESCALATE" == true && -n "$SUDO" ]]; then
            $SUDO mkdir -p "$dir"
            $SUDO chown "$(id -un):$(id -gn)" "$dir"
            return 0
        elif [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
            mkdir -p "$dir"
            return 0
        fi

        log_err "Directory '$dir' is not writable and sudo is unavailable."
        exit 1
    }

    ensure_dir_writable "$INSTALL_DIR"
    backup_user_files "$INSTALL_DIR"

    if [[ -d "$INSTALL_DIR/.git" ]]; then
        log_info "Updating existing repository in $INSTALL_DIR (branch: $REPO_BRANCH)..."
        if [[ -n "$(git -C "$INSTALL_DIR" -c safe.directory="$INSTALL_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
            log_warn "Local tracked modifications detected in $INSTALL_DIR; skipping git pull to avoid overwriting local changes."
        else
            git -C "$INSTALL_DIR" -c safe.directory="$INSTALL_DIR" fetch --depth 1 origin "$REPO_BRANCH"
            git -C "$INSTALL_DIR" -c safe.directory="$INSTALL_DIR" pull --ff-only origin "$REPO_BRANCH" || \
                log_warn "Could not fast-forward $INSTALL_DIR; keeping current checkout."
        fi
    elif [[ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
        log_info "Populating existing directory $INSTALL_DIR with fresh clone while preserving .env and deepseek-auth.json..."
        local CLONE_TMP="$BACKUP_DIR/repo"
        git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$CLONE_TMP"
        if command -v tar >/dev/null 2>&1; then
            tar -C "$CLONE_TMP" -cf - . | tar -C "$INSTALL_DIR" -xf -
        else
            cp -a "$CLONE_TMP/." "$INSTALL_DIR/"
        fi
    else
        log_info "Cloning $REPO_URL (branch: $REPO_BRANCH) into $INSTALL_DIR..."
        git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
    fi

    restore_user_files "$INSTALL_DIR"

    if [[ ! -f "$INSTALL_DIR/server.js" ]]; then
        log_err "Installation incomplete: $INSTALL_DIR/server.js not found."
        exit 1
    fi

    # ------------------------------------------------------------------
    # Install production Node dependencies (forward-compatible)
    # ------------------------------------------------------------------
    log_info "Running npm install --omit=dev in $INSTALL_DIR..."
    (cd "$INSTALL_DIR" && npm install --omit=dev)

    # Ensure scripts remain executable
    chmod +x "$INSTALL_DIR/server.js" "$INSTALL_DIR/cli.js" "$INSTALL_DIR/client.js" 2>/dev/null || true
    chmod +x "$INSTALL_DIR/deploy/"*.sh "$INSTALL_DIR/scripts/"*.js 2>/dev/null || true

    # ------------------------------------------------------------------
    # Optional browser check / setup
    # ------------------------------------------------------------------
    local EXISTING_BROWSER=""
    EXISTING_BROWSER="$(node -e "try{const{resolveChromePath}=require(process.argv[1]);console.log(resolveChromePath()||'')}catch{}" "$INSTALL_DIR/scripts/ensure_browser.js" 2>/dev/null || true)"
    if [[ -n "$EXISTING_BROWSER" ]]; then
        log_ok "Browser detected for auth login: $EXISTING_BROWSER"
    else
        local DO_BROWSER_INSTALL=false
        if [[ "$INSTALL_BROWSER" == "1" ]]; then
            DO_BROWSER_INSTALL=true
        elif [[ "$INSTALL_BROWSER" == "0" ]]; then
            DO_BROWSER_INSTALL=false
        elif [[ "$HAS_TTY" == true ]]; then
            if prompt_tty_yes_no "No Chromium browser found. Install Playwright Chromium now for local login capture?" "n"; then
                DO_BROWSER_INSTALL=true
            fi
        fi

        if [[ "$DO_BROWSER_INSTALL" == true ]]; then
            log_info "Installing Chromium via scripts/ensure_browser.js..."
            node "$INSTALL_DIR/scripts/ensure_browser.js" --install || \
                log_warn "Browser installation failed; you can retry later with 'npm run browser:install' or use 'npm run auth:import'."
        else
            log_info "Skipping browser installation (headless proxy works without a browser; use 'npm run browser:install' or 'npm run auth:import' later)."
        fi
    fi

    # ------------------------------------------------------------------
    # Service Setup: Linux systemd vs macOS LaunchAgent vs Non-systemd
    # ------------------------------------------------------------------
    ensure_local_env_and_auth() {
        local old_umask
        old_umask="$(umask)"
        umask 077

        if [[ ! -f "$INSTALL_DIR/.env" ]]; then
            local gen_key
            if command -v openssl >/dev/null 2>&1; then
                gen_key="sk-deepseek-$(openssl rand -hex 16)"
            else
                gen_key="sk-deepseek-$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")"
            fi
            if [[ -f "$INSTALL_DIR/.env.example" ]]; then
                cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
            else
                : > "$INSTALL_DIR/.env"
            fi
            node -e '
const fs = require("fs");
const file = process.argv[1];
const updates = { HOST: process.argv[2], PORT: process.argv[3], PROXY_API_KEY: process.argv[4], NON_INTERACTIVE: "1" };
let content = fs.readFileSync(file, "utf8");
for (const [k, v] of Object.entries(updates)) {
  const re = new RegExp(`^(?:export\\s+)?${k}\\s*=.*$`, "m");
  const line = `${k}="${String(v).replace(/["\\]/g, "\\$&")}"`;
  content = re.test(content) ? content.replace(re, () => line) : (content ? content.trimEnd() + "\n" : "") + line + "\n";
}
fs.writeFileSync(file, content, { mode: 0o600 });
' "$INSTALL_DIR/.env" "$HOST" "$PORT" "$gen_key"
            chmod 0600 "$INSTALL_DIR/.env"
            log_ok "Created $INSTALL_DIR/.env with generated PROXY_API_KEY"
        else
            chmod 0600 "$INSTALL_DIR/.env" 2>/dev/null || true
            log_info "Preserved existing $INSTALL_DIR/.env"
        fi

        if [[ ! -f "$INSTALL_DIR/deepseek-auth.json" ]] || [[ ! -s "$INSTALL_DIR/deepseek-auth.json" ]]; then
            printf '{}\n' > "$INSTALL_DIR/deepseek-auth.json"
            chmod 0600 "$INSTALL_DIR/deepseek-auth.json"
            log_info "Created valid JSON placeholder $INSTALL_DIR/deepseek-auth.json ({})"
        else
            chmod 0600 "$INSTALL_DIR/deepseek-auth.json" 2>/dev/null || true
            log_info "Preserved existing $INSTALL_DIR/deepseek-auth.json"
        fi

        umask "$old_umask"
    }

    setup_macos_launchagent() {
        ensure_local_env_and_auth
        local plist_label="com.deepseek.free-proxy"
        local agents_dir="$HOME/Library/LaunchAgents"
        local logs_dir="$HOME/Library/Logs/deepseek-free-proxy"
        local plist_path="$agents_dir/${plist_label}.plist"
        mkdir -p "$agents_dir" "$logs_dir"

        xml_escape() {
            local s="$1"
            s="${s//&/&amp;}"
            s="${s//</&lt;}"
            s="${s//>/&gt;}"
            printf '%s' "$s"
        }

        local x_node x_dir x_server x_host x_port x_out x_err x_path
        x_node="$(xml_escape "$NODE_BIN")"
        x_dir="$(xml_escape "$INSTALL_DIR")"
        x_server="$(xml_escape "$INSTALL_DIR/server.js")"
        x_host="$(xml_escape "$HOST")"
        x_port="$(xml_escape "$PORT")"
        x_out="$(xml_escape "$logs_dir/stdout.log")"
        x_err="$(xml_escape "$logs_dir/stderr.log")"
        x_path="$(xml_escape "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")"

        cat > "$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plist_label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${x_node}</string>
    <string>${x_server}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${x_dir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>NON_INTERACTIVE</key>
    <string>1</string>
    <key>HOST</key>
    <string>${x_host}</string>
    <key>PORT</key>
    <string>${x_port}</string>
    <key>PATH</key>
    <string>${x_path}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${x_out}</string>
  <key>StandardErrorPath</key>
  <string>${x_err}</string>
</dict>
</plist>
EOF
        chmod 0644 "$plist_path"

        local uid_num
        uid_num="$(id -u)"
        launchctl bootout "gui/${uid_num}" "$plist_path" 2>/dev/null || launchctl unload "$plist_path" 2>/dev/null || true
        if launchctl bootstrap "gui/${uid_num}" "$plist_path" 2>/dev/null || launchctl load -w "$plist_path" 2>/dev/null; then
            local probe_host="$HOST"
            [[ "$probe_host" == "0.0.0.0" || "$probe_host" == "*" ]] && probe_host="127.0.0.1"
            [[ "$probe_host" == "::" || "$probe_host" == "[::]" ]] && probe_host="[::1]"
            local ok_health=false
            for _i in 1 2 3 4 5 6 7 8 9 10; do
                if curl -fsS --max-time 2 "http://${probe_host}:${PORT}/health" >/dev/null 2>&1; then
                    ok_health=true
                    break
                fi
                sleep 0.5
            done
            if [[ "$ok_health" == true ]]; then
                log_ok "macOS LaunchAgent loaded and healthy at http://${probe_host}:${PORT}/health"
            else
                log_warn "LaunchAgent loaded ($plist_path), but /health probe did not respond yet. Check logs: $logs_dir/stderr.log"
                tail -n 20 "$logs_dir/stderr.log" 2>/dev/null || true
            fi
        else
            log_warn "Could not load LaunchAgent automatically (headless/SSH session?). Run foreground instead: cd $INSTALL_DIR && npm start"
        fi
    }

    if [[ "$OS_FAMILY" == "linux" && "$SYSTEMD_ACTIVE" == true && "$SKIP_SERVICE" != "1" ]]; then
        if [[ "$CAN_PRIV_ESCALATE" == true ]]; then
            local install_args=("--dir=$INSTALL_DIR" "--port=$PORT" "--host=$HOST" "--non-interactive")
            if [[ "$CURRENT_USER" == "1" ]]; then
                install_args+=("--current-user")
            elif [[ "$INSTALL_DIR" == /home/* || "$INSTALL_DIR" == /root/* ]]; then
                # If installing inside a potentially 0700 home directory without --current-user,
                # preserve user choice cleanly or let install.sh preflight guide/handle it.
                :
            fi
            log_info "Configuring Linux systemd service via deploy/install.sh..."
            $SUDO bash "$INSTALL_DIR/deploy/install.sh" "${install_args[@]}"
        else
            log_warn "systemd is active, but root/sudo privileges are not available. Setting up local .env for foreground run."
            ensure_local_env_and_auth
            echo "To install systemd service later, run: sudo $INSTALL_DIR/deploy/install.sh"
        fi
    elif [[ "$OS_FAMILY" == "darwin" && "$SKIP_SERVICE" != "1" ]]; then
        setup_macos_launchagent
    else
        if [[ "$OS_FAMILY" == "linux" && "$SYSTEMD_ACTIVE" != true ]]; then
            log_info "Non-systemd Linux environment detected (container / WSL / alternate init); skipping systemd service setup."
        fi
        ensure_local_env_and_auth
    fi

    echo ""
    log_ok "${BOLD}FreeDeepseekAPI installed in: $INSTALL_DIR${NC}"
    echo "Next steps:"
    echo "  1) Authenticate DeepSeek:"
    echo "     cd \"$INSTALL_DIR\" && npm run auth"
    echo "     (or import from another machine: cd \"$INSTALL_DIR\" && npm run auth:import -- --input ./deepseek-auth.json)"
    if [[ "$OS_FAMILY" == "linux" && "$SYSTEMD_ACTIVE" == true && "$SKIP_SERVICE" != "1" && "$CAN_PRIV_ESCALATE" == true ]]; then
        echo "     (for systemd, import directly to /etc/free-deepseek-api/deepseek-auth.json and run: sudo systemctl restart free-deepseek-api)"
    elif [[ "$OS_FAMILY" == "darwin" && "$SKIP_SERVICE" != "1" ]]; then
        echo "     LaunchAgent plist: $HOME/Library/LaunchAgents/com.deepseek.free-proxy.plist"
        echo "     Restart service:   launchctl kickstart -k gui/$(id -u)/com.deepseek.free-proxy"
    else
        echo "  2) Start proxy in foreground:"
        echo "     cd \"$INSTALL_DIR\" && NON_INTERACTIVE=1 npm start"
    fi
    echo "  Diagnostics: cd \"$INSTALL_DIR\" && npm run doctor"
    echo ""
}

main "$@"
