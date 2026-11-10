#!/usr/bin/env bash
# 每天 23:00 由 bili-autostart.timer 触发：调用本机 Web 服务的 /api/run 启动一轮抽奖任务。
# 服务端自带互斥（已有任务运行时返回“已有任务运行中”），本脚本把这种情况记为跳过而非失败。
set -uo pipefail

BASE="${BILI_WEB_BASE:-http://127.0.0.1:8787}"
LOG_TAG="bili-autostart"
HOSTHDR="127.0.0.1:8787"

log() { echo "[$(date '+%F %T')] $*"; logger -t "$LOG_TAG" "$*" 2>/dev/null || true; }

# 取 bootstrap：服务没起来时先尝试拉起，再重试三次
boot=""
for i in 1 2 3; do
    boot=$(curl -sS --max-time 10 -H "Host: $HOSTHDR" "$BASE/api/bootstrap" 2>/dev/null) && [ -n "$boot" ] && break
    if [ "$i" = 1 ]; then systemctl start bili-web 2>/dev/null || true; fi
    sleep 3
done
if [ -z "$boot" ]; then log "失败：Web 服务不可达，本轮跳过。"; exit 1; fi

token=$(printf '%s' "$boot" | sed -n 's/.*"webToken":"\([0-9a-f]\{64\}\)".*/\1/p')
[ -n "$token" ] || { log "失败：取不到 webToken（页面刷新后 token 会变，属正常）。"; exit 1; }

case "$boot" in *'"loggedIn":false'*) log "跳过：账号未登录，定时任务不执行。"; exit 0 ;; esac
case "$boot" in *'"hasUid":false'*)  log "跳过：尚未填写并保存 B 站 UID。"; exit 0 ;; esac
case "$boot" in *'"running":true'*)  log "跳过：已有任务在跑，等它结束。"; exit 0 ;; esac

t0=$(date +%s)
resp=$(curl -sS --max-time 60 -X POST -H "Host: $HOSTHDR" \
        -H 'Content-Type: application/json' -H "X-Web-Token: $token" \
        -d '{"action":"start"}' "$BASE/api/run" 2>&1)
code=$?
log "启动耗时 $(( $(date +%s) - t0 ))s，响应：$resp"

case "$resp" in
    *已有任务运行中*) exit 0 ;;
    *'"error"'*)      exit 3 ;;
esac
[ $code -eq 0 ] || exit $code
exit 0
