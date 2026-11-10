#!/usr/bin/env bash
# WorkBuddy Daily 运行包装器
# 用法: run.sh [workbuddy_daily.py 的额外参数]
set -uo pipefail

APP_DIR=/opt/workbuddy/app
ENV_FILE=/opt/workbuddy/workbuddy.env
CRED_FILE=/opt/workbuddy/credentials.env
LOG_DIR=/opt/workbuddy/logs
STATE_DIR=/opt/workbuddy/state

export TZ=Asia/Shanghai
export PYTHONUNBUFFERED=1
export WORKBUDDY_STATE_DIR="$STATE_DIR"

set -a
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi
# 令牌单独一份，权限 600，由 login.sh 维护
if [ -f "$CRED_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CRED_FILE"
fi
set +a

LOG="$LOG_DIR/run-$(date +%F).log"
cd "$APP_DIR" || exit 1

{
  echo "=== $(date '+%F %T %Z') start (args: $*) ==="

  if [ -n "${WORKBUDDY_REFRESH_TOKEN:-}" ]; then
    echo "--- 国内版 workbuddy_daily.py ---"
    python3 workbuddy_daily.py "$@"
    echo "--- 国内版 exit=$? ---"
  fi

  if [ -n "${WORKBUDDY_INTL_TOKENS:-}${WORKBUDDY_TOKEN:-}" ]; then
    echo "--- 国际版 workbuddy_intl_daily.py ---"
    python3 workbuddy_intl_daily.py
    echo "--- 国际版 exit=$? ---"
  fi

  if [ -z "${WORKBUDDY_REFRESH_TOKEN:-}${WORKBUDDY_INTL_TOKENS:-}${WORKBUDDY_TOKEN:-}" ]; then
    echo "!! 未配置任何令牌（WORKBUDDY_REFRESH_TOKEN / WORKBUDDY_INTL_TOKENS），跳过本轮"
  fi

  echo "=== $(date '+%F %T %Z') end ==="
} >> "$LOG" 2>&1

# 日志保留 14 天
find "$LOG_DIR" -name 'run-*.log' -mtime +14 -delete 2>/dev/null

# 令牌文件收紧权限
find "$STATE_DIR" -type f -exec chmod 600 {} + 2>/dev/null
exit 0
