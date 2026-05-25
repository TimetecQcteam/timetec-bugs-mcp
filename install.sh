#!/usr/bin/env bash
# Claude Code timetec-bugs-mcp installer (Linux / macOS one-shot).
#
# Sets up the timetec-bugs MCP server in Claude Code:
#   1. Runs `npm install` in this folder (Node dependencies)
#   2. Prompts for environment, credentials, and optional paths
#   3. Registers the MCP server in either:
#        - User scope:    ~/.claude.json   (default)
#        - Project scope: ./.mcp.json      (--scope project)
#
# Safe to re-run: existing values are shown as defaults; press Enter
# to keep them. The password prompt also accepts Enter to keep the
# previously configured password.
#
# Usage:
#   ./install.sh                              # user scope, name "timetec-bugs"
#   ./install.sh --scope project              # write to ./.mcp.json
#   ./install.sh --name timetec-bugs-sit      # custom entry name
#   ./install.sh --skip-credentials           # register entry without prompting
#                                             # for email/password; user supplies
#                                             # them later via the MCP's
#                                             # `setup_credentials` tool
#   ./install.sh /custom/home                 # alternative target root

set -euo pipefail

SCOPE='user'
NAME='timetec-bugs'
TARGET_ROOT="$HOME"
SKIP_CREDENTIALS=0

while [ $# -gt 0 ]; do
    case "$1" in
        --scope)             SCOPE="$2"; shift 2;;
        --name)              NAME="$2";  shift 2;;
        --skip-credentials)  SKIP_CREDENTIALS=1; shift;;
        -h|--help)           sed -n 's/^# \{0,1\}//p' "$0" | sed -n '1,/^$/p'; exit 0;;
        *)                   TARGET_ROOT="$1"; shift;;
    esac
done

# --- styling ------------------------------------------------------
if [ -t 1 ]; then
    C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
    C_RED=$'\033[31m';  C_WHITE=$'\033[37m'; C_RESET=$'\033[0m'
else
    C_CYAN=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_WHITE=''; C_RESET=''
fi
step() { printf '  %s%s%s\n' "$C_CYAN"  "$1" "$C_RESET"; }
ok()   { printf '  %s%s%s\n' "$C_GREEN" "$1" "$C_RESET"; }
warn() { printf '  %s%s%s\n' "$C_YELLOW" "$1" "$C_RESET"; }
err()  { printf '  %s%s%s\n' "$C_RED"   "$1" "$C_RESET" >&2; }

echo
printf '  %s=== timetec-bugs-mcp installer ===%s\n' "$C_WHITE" "$C_RESET"
echo

# --- paths --------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_JS="$SCRIPT_DIR/server.js"
ENTRY_POINT="$SCRIPT_DIR/bootstrap.js"
PACKAGE_JSON="$SCRIPT_DIR/package.json"

case "$SCOPE" in
    user)    CONFIG_PATH="$TARGET_ROOT/.claude.json" ;;
    project) CONFIG_PATH="$(pwd)/.mcp.json" ;;
    *)       err "Unknown --scope value: $SCOPE (expected 'user' or 'project')"; exit 1;;
esac

# --- prerequisite checks -----------------------------------------
step "Checking source files..."
[ -f "$SERVER_JS" ]    || { err "Missing server.js - run from timetec-bugs-mcp folder root."; exit 1; }
[ -f "$ENTRY_POINT" ]  || { err "Missing bootstrap.js - run from timetec-bugs-mcp folder root."; exit 1; }
[ -f "$PACKAGE_JSON" ] || { err "Missing package.json"; exit 1; }
ok "Source files OK"

step "Checking Node..."
command -v node >/dev/null 2>&1 || { err "Node not found on PATH. Install from https://nodejs.org/ first."; exit 1; }
ok "Node OK: $(command -v node)"

step "Checking python3..."
command -v python3 >/dev/null 2>&1 || { err "python3 not found on PATH. Install Python 3 first."; exit 1; }
ok "python3 OK: $(command -v python3)"

# --- 1. npm install ----------------------------------------------
step "Running npm install in $SCRIPT_DIR ..."
( cd "$SCRIPT_DIR" && npm install --silent )
ok "Dependencies installed."

# --- 2. read existing entry's env for defaults -------------------
EXISTING_ENV_JSON='{}'
if [ -f "$CONFIG_PATH" ]; then
    EXISTING_ENV_JSON="$(CONFIG_PATH="$CONFIG_PATH" NAME="$NAME" python3 <<'PYEOF'
import json, os
path = os.environ['CONFIG_PATH']
name = os.environ['NAME']
try:
    with open(path, 'r', encoding='utf-8') as f:
        text = f.read().strip()
    data = json.loads(text) if text else {}
except Exception:
    data = {}
entry = (data.get('mcpServers') or {}).get(name) or {}
print(json.dumps(entry.get('env') or {}))
PYEOF
)"
fi

get_existing() {
    python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d.get(sys.argv[2],''))" "$EXISTING_ENV_JSON" "$1"
}

prompt_default() {
    local label="$1" default="$2" reply
    if [ -n "$default" ]; then
        read -r -p "  $label [$default]: " reply || true
        [ -z "$reply" ] && reply="$default"
    else
        read -r -p "  $label: " reply || true
    fi
    printf '%s' "$reply"
}

prompt_password() {
    local label="$1" default="$2" reply hint=''
    [ -n "$default" ] && hint=' (Enter to keep existing)'
    read -r -s -p "  ${label}${hint}: " reply || true
    echo
    if [ -z "$reply" ] && [ -n "$default" ]; then
        reply="$default"
    fi
    printf '%s' "$reply"
}

# --- 3. prompts ---------------------------------------------------
echo
step "Configure timetec-bugs MCP entry"
echo "    Entry name : $NAME"
echo "    Scope      : $SCOPE"
echo "    Config file: $CONFIG_PATH"
echo

LIVE_URL='https://dt.timeteccloud.com'
SIT_URL='https://dt-dev.timeteccloud.com'
EXISTING_URL="$(get_existing TIMETEC_BASE_URL)"

PRESET_DEFAULT='1'
if [ "$EXISTING_URL" = "$SIT_URL" ]; then
    PRESET_DEFAULT='2'
elif [ -n "$EXISTING_URL" ] && [ "$EXISTING_URL" != "$LIVE_URL" ]; then
    PRESET_DEFAULT='3'
fi

echo "  Environment:"
echo "    1) Live  ($LIVE_URL)"
echo "    2) SIT   ($SIT_URL)"
echo "    3) Custom URL"
PRESET="$(prompt_default "Choose [1/2/3]" "$PRESET_DEFAULT")"

case "$PRESET" in
    2) BASE_URL="$SIT_URL" ;;
    3) BASE_URL="$(prompt_default "Custom base URL" "$EXISTING_URL")" ;;
    *) BASE_URL="$LIVE_URL" ;;
esac

if [ "$SKIP_CREDENTIALS" = "1" ]; then
    step "Skipping credential prompts (--skip-credentials)."
    echo "    Use the MCP's setup_credentials tool from Claude Code to configure them later."
    EMAIL=""
    PASSWORD=""
else
    EMAIL="$(prompt_default      "Email"    "$(get_existing TIMETEC_EMAIL)")"
    PASSWORD="$(prompt_password  "Password" "$(get_existing TIMETEC_PASSWORD)")"

    [ -n "$EMAIL" ]    || { err "Email is required."; exit 1; }
    [ -n "$PASSWORD" ] || { err "Password is required."; exit 1; }
fi

ADB_DEFAULT="$(get_existing ADB_PATH)"
[ -z "$ADB_DEFAULT" ] && ADB_DEFAULT="$HOME/Android/Sdk/platform-tools/adb"
ADB_PATH_VAL="$(prompt_default "ADB path (optional)" "$ADB_DEFAULT")"

ONEDRIVE="$(prompt_default "OneDrive sync folder (optional)" "$(get_existing ONEDRIVE_SYNC_FOLDER)")"
SHAREPOINT="$(prompt_default "SharePoint base URL (optional)" "$(get_existing SHAREPOINT_BASE_URL)")"

# --- 4. write -----------------------------------------------------
step "Writing config to $CONFIG_PATH ..."
mkdir -p "$(dirname "$CONFIG_PATH")"

CONFIG_PATH="$CONFIG_PATH" NAME="$NAME" ENTRY_POINT="$ENTRY_POINT" \
BASE_URL="$BASE_URL" EMAIL="$EMAIL" PASSWORD="$PASSWORD" \
ADB_PATH_VAL="$ADB_PATH_VAL" ONEDRIVE="$ONEDRIVE" SHAREPOINT="$SHAREPOINT" \
python3 <<'PYEOF'
import json, os, shutil

path = os.environ['CONFIG_PATH']
name = os.environ['NAME']

data = {}
if os.path.exists(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            text = f.read().strip()
        if text:
            data = json.loads(text)
    except Exception:
        shutil.copyfile(path, path + '.bak')
        print(f'  Existing {path} failed to parse; backed up to {path}.bak')
        data = {}

servers = data.setdefault('mcpServers', {})
existing = servers.get(name) or {}
existing_env = (existing.get('env') or {}) if isinstance(existing, dict) else {}

# Preserve any existing env keys we don't ask about, then overlay.
env = dict(existing_env)
env['TIMETEC_BASE_URL'] = os.environ['BASE_URL']
for k, v in (
    ('TIMETEC_EMAIL',        os.environ.get('EMAIL',        '')),
    ('TIMETEC_PASSWORD',     os.environ.get('PASSWORD',     '')),
    ('ADB_PATH',             os.environ.get('ADB_PATH_VAL', '')),
    ('ONEDRIVE_SYNC_FOLDER', os.environ.get('ONEDRIVE',     '')),
    ('SHAREPOINT_BASE_URL',  os.environ.get('SHAREPOINT',   '')),
):
    if v:
        env[k] = v

servers[name] = {
    'command': 'node',
    'args':    [os.environ['ENTRY_POINT']],
    'env':     env,
}

with open(path, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2)
    f.write('\n')

print(f'  MCP entry written.')
PYEOF
ok "Done."

# --- summary -----------------------------------------------------
echo
printf '  %s=== Done ===%s\n' "$C_GREEN" "$C_RESET"
echo
echo "  Entry name : $NAME"
echo "  MCP server : $ENTRY_POINT"
echo "  Base URL   : $BASE_URL"
if [ -n "$EMAIL" ]; then
    echo "  Email      : $EMAIL"
else
    printf '  %sEmail      : (not set — call the MCP'\''s setup_credentials tool from Claude Code)%s\n' "$C_YELLOW" "$C_RESET"
fi
echo "  Config file: $CONFIG_PATH"
echo
echo "  Restart Claude Code to pick it up."
echo
