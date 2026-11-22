# bin/_ops-common.sh — shared helpers for the OmniRoute ops runbook scripts.
#
# Sourced (not executed) by rollback.sh / cold-start-bench.sh. Each script documents its own
# contract via --help. (The SQLite snapshot/restore scripts were removed: data lives in
# PostgreSQL, which is backed up with pg_dump.)

ops_log() { printf '[%s] %s\n' "${SCRIPT_NAME:-ops}" "$*" >&2; }
ops_die() {
  printf '[%s] ERROR: %s\n' "${SCRIPT_NAME:-ops}" "$*" >&2
  exit 1
}

ops_require_cmd() {
  command -v "$1" >/dev/null 2>&1 || ops_die "required command not found: $1"
}

# ops_confirm "<prompt>" — return 0 to proceed. Honors ASSUME_YES=1 (set by the
# --yes flag) and REFUSES a destructive action on a non-interactive stdin unless
# ASSUME_YES is set, so an unattended/CI invocation can never silently destroy data.
ops_confirm() {
  local prompt="$1" reply
  if [ "${ASSUME_YES:-0}" = "1" ]; then return 0; fi
  if [ ! -t 0 ]; then
    ops_die "refusing a destructive action without a TTY; pass --yes to proceed non-interactively"
  fi
  read -r -p "$prompt [y/N] " reply
  case "$reply" in
    [yY] | [yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}
