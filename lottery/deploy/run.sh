#!/usr/bin/env bash
# LotteryAutoScript 运行包装：把 stdout/stderr 同时写进按天日志，供日志查看器读
# 用法: ./run.sh start | check | clear | login | acount
set -uo pipefail

# 脚本放在项目根或 deploy/ 下都能用
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HERE"
[ -f "$HERE/package.json" ] || APP_DIR="$(dirname "$HERE")"
cd "$APP_DIR"

LOG_DIR="${LOG_DIR:-./logs}"
mkdir -p "$LOG_DIR"

cmd="${1:-start}"

# check 单独一个文件：它和 start 会并发写，混在一个文件里日志会交错难读
case "$cmd" in
  check) LOG_FILE="$LOG_DIR/lottery-check-$(date +%F).log" ;;
  *)     LOG_FILE="$LOG_DIR/lottery-$(date +%F).log" ;;
esac

shift || true

printf '[%s] [Info] ===== 启动 lottery %s %s =====\n' \
  "$(date '+%F %T')" "$cmd" "$*" >> "$LOG_FILE"

# tee 保证终端/ journal 也能看到；行缓冲，避免日志延迟
node main.js "$cmd" "$@" 2>&1 | tee -a "$LOG_FILE"
exit "${PIPESTATUS[0]}"
