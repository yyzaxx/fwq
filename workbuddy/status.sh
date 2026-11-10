#!/usr/bin/env bash
# WorkBuddy Daily 一键状态检查
#   bash /opt/workbuddy/status.sh
set -uo pipefail

ENVF=/opt/workbuddy/workbuddy.env
CREDF=/opt/workbuddy/credentials.env
STATE=/opt/workbuddy/state
LOGD=/opt/workbuddy/logs

echo "── 定时器 ──────────────────────────────────────────────"
systemctl list-timers workbuddy.timer --no-pager 2>/dev/null | head -3
systemctl is-enabled workbuddy.timer 2>/dev/null | sed 's/^/enabled: /'
systemctl is-active workbuddy.timer 2>/dev/null | sed 's/^/active : /'

echo
echo "── 令牌 ────────────────────────────────────────────────"
if [ -s "$CREDF" ] && grep -q "WORKBUDDY_REFRESH_TOKEN='.." "$CREDF" 2>/dev/null; then
  echo "credentials.env: 已配置 $(grep -c ':' "$CREDF" 2>/dev/null | head -1) 行"
else
  echo "credentials.env: ⚠️ 还没有令牌 —— 先跑 bash /opt/workbuddy/login.sh"
fi
if [ -f "$STATE/wb_refresh_tokens.json" ]; then
  python3 - "$STATE/wb_refresh_tokens.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
for k, v in d.items():
    at = v.get('access_token') or ''
    print('  账号 %s | AT %s | RT %s' % (k, '有' if at else '无', '有' if v.get('refresh_token') else '无'))
PY
fi

echo
echo "── 最近一次运行 ────────────────────────────────────────"
LAST=$(ls -1t "$LOGD"/run-*.log 2>/dev/null | head -1)
if [ -n "${LAST:-}" ]; then
  echo "文件: $LAST  ($(du -h "$LAST" | cut -f1))"
  echo "---- 末尾 30 行 ----"
  tail -30 "$LAST"
else
  echo "还没有运行日志"
fi

echo
echo "── 推送渠道 ────────────────────────────────────────────"
if grep -qE '^(PUSHPLUS_TOKEN|BARK_URL|WXPUSHER_APP_TOKEN|SERVERCHAN_SENDKEY|WECOM_WEBHOOK|DINGTALK_WEBHOOK)=..' "$ENVF" 2>/dev/null; then
  echo "已配置（见 workbuddy.env）"
else
  echo "未配置 —— 报告只写本地日志"
fi
