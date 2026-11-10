#!/usr/bin/env bash
# WorkBuddy 国内版短信登录 + 自动写入令牌
#
#   bash /opt/workbuddy/login.sh              # 交互式（输手机号 → 收验证码 → 输验证码）
#   bash /opt/workbuddy/login.sh 138xxxxxxxx  # 指定手机号（仍会等验证码）
#   bash /opt/workbuddy/login.sh 138xxxxxxxx 123456
#
# 跑完把「手机号:AT:RT」合并进 /opt/workbuddy/credentials.env（同号覆盖，多号并存，权限 600）。
set -uo pipefail

APP_DIR=/opt/workbuddy/app
CRED_FILE=/opt/workbuddy/credentials.env

export TZ=Asia/Shanghai
cd "$APP_DIR" || exit 1

python3 workbuddy_login.py "$@" || exit $?

python3 - "$CRED_FILE" <<'PY'
import json, os, sys

cred = sys.argv[1]
try:
    line = json.load(open('/opt/workbuddy/app/wb_login_result.json', encoding='utf-8'))[-1]['env_line'].strip()
except Exception as e:
    print('❌ 读不到登录结果: %s' % e)
    sys.exit(1)

phone = line.split(':', 1)[0]

old = ''
if os.path.exists(cred):
    txt = open(cred, encoding='utf-8').read()
    if "'" in txt:
        old = txt.split("'", 1)[1].rsplit("'", 1)[0]

accts = [a.strip() for a in old.replace('@', '\n').splitlines() if a.strip()]
accts = [a for a in accts if not a.startswith(phone + ':')]
accts.append(line)

with open(cred, 'w', encoding='utf-8') as f:
    f.write('# 由 login.sh 自动维护：每行一个「手机号:AT:RT」。请勿外传，勿提交到仓库。\n')
    f.write("WORKBUDDY_REFRESH_TOKEN='" + '\n'.join(accts) + "'\n")
os.chmod(cred, 0o600)
print('✅ 已写入 %s（当前 %d 个账号，权限 600）' % (cred, len(accts)))
PY

echo
echo "下一步：bash /opt/workbuddy/run.sh --query   # 只读试跑，确认令牌可用"
