#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WorkBuddy Daily 控制台（单文件 · 仅标准库）

功能：短信登录取令牌 / 查看令牌与定时状态 / 手动跑任务 / 看日志。
安全：口令登录 + HMAC 会话 Cookie，令牌永远不返回给浏览器。
"""
import base64
import contextlib
import hmac
import io
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = "/opt/workbuddy"
APP_DIR = os.path.join(BASE_DIR, "app")
CRED_FILE = os.path.join(BASE_DIR, "credentials.env")
SECRET_FILE = os.path.join(BASE_DIR, "panel.secret")
PASS_FILE = os.path.join(BASE_DIR, "panel.password")
RUN_SH = os.path.join(BASE_DIR, "run.sh")
LOG_DIR = os.path.join(BASE_DIR, "logs")
STATE_DIR = os.path.join(BASE_DIR, "state")

PORT = int(os.environ.get("PANEL_PORT", "8600"))
BIND = os.environ.get("PANEL_BIND", "0.0.0.0")
COOKIE = "wb_panel"
SESSION_TTL = 7 * 86400

PHONE_RE = re.compile(r"^1[3-9]\d{9}$")


def _read(path, default=""):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except Exception:
        return default


SECRET = _read(SECRET_FILE).strip()
if not SECRET:
    SECRET = secrets.token_hex(32)
    with open(SECRET_FILE, "w", encoding="utf-8") as f:
        f.write(SECRET)
    os.chmod(SECRET_FILE, 0o600)

PASSWORD = _read(PASS_FILE).strip()

_run_lock = threading.Lock()
_run_state = {"running": False, "started": 0, "args": ""}
_sms_state = {"last": 0.0}
_fail_state = {}


# ───────────────────────── 凭据 ─────────────────────────

def mask_phone(p):
    p = str(p)
    if len(p) >= 8:
        return p[:3] + "****" + p[-4:]
    return p[:2] + "***"


def read_accounts():
    """从 credentials.env 读账号（不返回令牌）"""
    txt = _read(CRED_FILE)
    if "'" not in txt:
        return []
    raw = txt.split("'", 1)[1].rsplit("'", 1)[0]
    out = []
    for line in raw.replace("@", "\n").splitlines():
        line = line.strip()
        if not line:
            continue
        phone = line.split(":", 1)[0]
        out.append(mask_phone(phone))
    return out


def write_account(env_line):
    """合并写入 credentials.env（同号覆盖）"""
    env_line = env_line.strip()
    phone = env_line.split(":", 1)[0]
    old = ""
    txt = _read(CRED_FILE)
    if "'" in txt:
        old = txt.split("'", 1)[1].rsplit("'", 1)[0]
    accts = [a.strip() for a in old.replace("@", "\n").splitlines() if a.strip()]
    accts = [a for a in accts if not a.startswith(phone + ":")]
    accts.append(env_line)
    with open(CRED_FILE, "w", encoding="utf-8") as f:
        f.write("# 由控制台自动维护：每行一个「手机号:AT:RT」。请勿外传，勿提交到仓库。\n")
        f.write("WORKBUDDY_REFRESH_TOKEN='" + "\n".join(accts) + "'\n")
    os.chmod(CRED_FILE, 0o600)
    return len(accts)


def wb_module():
    if APP_DIR not in sys.path:
        sys.path.insert(0, APP_DIR)
    import workbuddy_login  # noqa: E402
    return workbuddy_login


def sms_send(phone):
    w = wb_module()
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        ok, msg = w.send_sms(phone)
    return ok, msg


def sms_login(phone, code):
    w = wb_module()
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        res = w.login(phone, code)
    if not res:
        tail = [l for l in buf.getvalue().splitlines() if "❌" in l or "💡" in l]
        return False, (" / ".join(x.strip() for x in tail) or "登录失败")
    return True, "%s:%s:%s" % (phone, res["accessToken"], res["refreshToken"])


# ───────────────────────── 状态 ─────────────────────────

def timer_info():
    info = {"next": "", "enabled": "", "active": ""}
    for key, args in (("enabled", ["systemctl", "is-enabled", "workbuddy.timer"]),
                      ("active", ["systemctl", "is-active", "workbuddy.timer"])):
        try:
            info[key] = subprocess.run(args, capture_output=True, text=True, timeout=5).stdout.strip()
        except Exception:
            info[key] = "?"
    try:
        r = subprocess.run(["systemctl", "list-timers", "workbuddy.timer", "--no-pager", "--output=json"],
                           capture_output=True, text=True, timeout=5)
        data = json.loads(r.stdout)
        if data:
            nxt = data[0].get("next", "")
            try:
                info["next"] = time.strftime("%m-%d %H:%M", time.localtime(int(nxt) / 1e6))
            except Exception:
                info["next"] = str(nxt)
    except Exception:
        try:
            r = subprocess.run(["systemctl", "list-timers", "workbuddy.timer", "--no-pager"],
                               capture_output=True, text=True, timeout=5)
            lines = r.stdout.splitlines()
            if len(lines) > 1:
                info["next"] = " ".join(lines[1].split()[:3])
        except Exception:
            pass
    return info


def state_info():
    out = []
    try:
        with open(os.path.join(STATE_DIR, "wb_refresh_tokens.json"), encoding="utf-8") as f:
            store = json.load(f)
        for k, v in store.items():
            out.append({"account": mask_phone(k),
                        "has_at": bool(v.get("access_token")),
                        "has_rt": bool(v.get("refresh_token")),
                        "refreshed": str(v.get("refresh_time") or v.get("updated_at") or "")[:19]})
    except Exception:
        pass
    return out


def newest_log():
    try:
        logs = [os.path.join(LOG_DIR, f) for f in os.listdir(LOG_DIR) if f.startswith("run-") and f.endswith(".log")]
        if not logs:
            return None
        return max(logs, key=os.path.getmtime)
    except Exception:
        return None


def tail_log(n=200):
    p = newest_log()
    if not p:
        return "（还没有运行日志）"
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            lines = f.readlines()[-n:]
        return "".join(lines) or "（日志为空）"
    except Exception as e:
        return "读取日志失败: %s" % e


def last_run_meta():
    p = newest_log()
    if not p:
        return {"at": "", "size": 0, "accounts": [], "summary": "还没有运行记录"}
    try:
        st = os.stat(p)
    except Exception:
        return {"at": "", "size": 0, "accounts": [], "summary": ""}
    text = tail_log(4000)
    accounts = sorted(set(re.findall(r"账号\d+\s+([0-9]{2,3}\*+[0-9]{2,4})", text)))
    ok = "全部完成" in text
    return {"at": time.strftime("%Y-%m-%d %H:%M", time.localtime(st.st_mtime)),
            "size": st.st_size, "accounts": accounts,
            "summary": "全部完成" if ok else "见日志"}


# ───────────────────────── 运行 ─────────────────────────

def start_run(extra_args=""):
    if not _run_lock.acquire(blocking=False):
        return False, "上一轮还在跑，等它结束"
    if _run_state["running"]:
        _run_lock.release()
        return False, "上一轮还在跑，等它结束"

    def _worker():
        try:
            _run_state.update(running=True, started=time.time(), args=extra_args)
            cmd = ["/bin/bash", RUN_SH] + ([extra_args] if extra_args else [])
            subprocess.run(cmd, timeout=3600)
        except Exception:
            pass
        finally:
            _run_state["running"] = False
            _run_lock.release()

    threading.Thread(target=_worker, daemon=True).start()
    return True, "已开始"


# ───────────────────────── HTTP ─────────────────────────

PAGE = r"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#247b59"><meta name="color-scheme" content="light"><title>WorkBuddy · 每日任务管理</title><style>:root{--bg:#f5f7f9;--surface:#fff;--text:#202c2b;--muted:#7a8583;--line:#e7ecea;--green:#247b59;--green-dark:#196244;--green-soft:#eaf5ee;--red:#c24545;--shadow:0 3px 16px #203b2d04;--radius:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--text);background:var(--bg);font-synthesis:none}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;font-size:14px;line-height:1.6}button,input{font:inherit}button,a,input{-webkit-tap-highlight-color:transparent}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.55}a{color:inherit;text-decoration:none}button,a,input{outline-offset:4px}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #80b99d}.icon{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}.svg-library{position:absolute;width:0;height:0;overflow:hidden}.sidebar{position:fixed;inset:0 auto 0 0;width:226px;display:flex;flex-direction:column;padding:32px 19px 22px;background:#fff;border-right:1px solid var(--line);z-index:10}.brand{display:flex;align-items:center;gap:11px;padding:0 7px}.brand-mark{display:grid;place-items:center;width:36px;height:42px;color:var(--green)}.brand-mark svg{width:35px;height:35px}.brand strong{font-size:22px;letter-spacing:-.8px;display:block;line-height:1.3;color:#172c23}.brand small{display:block;color:var(--muted);font-size:12px;margin-top:4px;letter-spacing:1px}.navigation{display:grid;gap:9px;margin-top:47px}.nav-link{display:flex;align-items:center;gap:12px;padding:12px 15px;color:#79827e;border-radius:9px;font-weight:500;transition:background .15s,color .15s}.nav-link:hover{background:#f4f8f5;color:var(--green)}.nav-link.active{background:var(--green-soft);color:var(--green-dark);font-weight:650}.sidebar-bottom{margin-top:auto;color:var(--muted);font-size:12px;padding:20px 10px 0}.service-indicator{display:flex;align-items:center;gap:8px}.dot{display:inline-block;background:#369b6a;width:7px;height:7px;border-radius:50%;flex-shrink:0}.dot.warn{background:#d49a36}.dot.offline{background:#bd6969}.sidebar-note{font-size:11px;color:#a2aaa5;margin-top:8px}.main{margin-left:226px;padding:0 36px 24px;max-width:1640px}.topbar{height:77px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:12px}.breadcrumbs{font-size:12px;display:flex;gap:13px;color:var(--muted)}.breadcrumbs strong{color:#4a5550;font-weight:500}.topbar-right{display:flex;align-items:center;gap:18px;color:var(--muted);font-size:12px}.avatar{border-radius:50%;display:grid;place-items:center;background:var(--green);color:white;width:31px;height:31px;font-weight:600;font-size:14px}.heading-row{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:30px 0 25px}.heading-row h1{font-size:25px;letter-spacing:-.8px;margin:0 0 7px;line-height:1.45;font-weight:700}.heading-row p{margin:0;color:var(--muted);font-size:13px}.button{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--line);border-radius:8px;background:#fff;color:#55645c;padding:9px 15px;font-size:12px;font-weight:550;min-height:39px;white-space:nowrap;transition:background .15s,transform .15s}.button:hover:not(:disabled){background:#f4f8f5;border-color:#cadbd0}.button:active:not(:disabled){transform:translateY(1px)}.button .icon{width:16px;height:16px}.button.primary{background:var(--green);border-color:var(--green);color:#fff}.button.primary:hover:not(:disabled){background:var(--green-dark)}.button.outline{border-color:#c2d8cc;color:var(--green)}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:15px;margin-bottom:23px}.stat{background:white;border:1px solid var(--line);box-shadow:var(--shadow);border-radius:var(--radius);padding:22px 16px;display:flex;gap:13px;min-height:122px}.stat-icon{background:#edf7f0;color:var(--green);width:38px;height:38px;border-radius:10px;display:grid;place-items:center;flex-shrink:0}.stat-label{font-size:12px;color:#6d7972;margin-bottom:5px}.stat-value{display:flex;align-items:center;gap:8px;font-weight:650;font-size:24px;color:#26382d;letter-spacing:-.7px;line-height:1.35;min-height:33px;font-variant-numeric:tabular-nums}.stat-value.numeric{font-size:29px}.stat-caption{font-size:11px;color:#929c95;margin-top:5px}.content-grid{display:grid;grid-template-columns:minmax(0,1.12fr) minmax(0,1fr);gap:22px;align-items:stretch;margin-bottom:23px}.panel{background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow);border-radius:var(--radius);padding:23px 24px;scroll-margin-top:24px;min-width:0}.panel-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.panel-heading h2{font-size:16px;letter-spacing:-.3px;margin:0;font-weight:650}.badge{display:inline-flex;align-items:center;gap:6px;border-radius:5px;background:var(--green-soft);color:var(--green);font-size:11px;line-height:1.5;padding:3px 8px;white-space:nowrap}.badge.neutral{color:#879088;background:#f2f5f3}.badge.warn{background:#fff5df;color:#a2771a}.badge.error{background:#fbeeee;color:var(--red)}.account-list{margin:0 0 19px;padding:0;list-style:none;border-bottom:1px solid var(--line);padding-bottom:13px}.account-row{display:flex;align-items:center;gap:11px;padding:12px 0}.account-row+.account-row{border-top:1px solid #f1f4f2}.account-avatar{width:33px;height:33px;border-radius:50%;background:#edf6f0;color:#7baf91;display:grid;place-items:center;flex-shrink:0}.account-name{font-size:13px;font-weight:600;letter-spacing:.3px}.account-token{font-size:10px;color:#8f9891;margin-top:2px}.account-info{flex:1;min-width:0}.empty{color:var(--muted);font-size:12px;padding:22px 0;line-height:1.9}.field-row{display:flex;gap:10px;align-items:flex-end;margin-bottom:12px}.field{display:flex;flex-direction:column;gap:6px;flex:1;min-width:0}.field label{font-size:11px;color:#5c6a61;font-weight:550}.field input{width:100%;height:39px;border:1px solid #dbe4de;border-radius:7px;padding:8px 12px;min-width:0;background:#fff;color:var(--text);font-size:12px;transition:border-color .15s}.field input:focus{border-color:#69a485}.field input::placeholder{color:#adb5af}.wide{width:100%}.form-note{margin:10px 0 0;font-size:10px;color:#969e98;line-height:1.8}.feedback{font-size:12px;line-height:1.7}.feedback:not(:empty){padding:9px 11px;border-radius:7px;margin:10px 0;background:#eef5f0}.feedback.err{color:#ac4545;background:#fff1f1}.feedback.ok{color:var(--green)}.feedback.info{color:#69796f}.feedback:empty{display:none}.schedule{display:flex;align-items:center;gap:12px;background:#edf7f0;border-radius:10px;padding:16px;margin:19px 0 15px;color:var(--green)}.schedule .icon{width:25px;height:25px}.schedule strong{font-size:13px;font-weight:600;display:block}.schedule p{font-size:11px;margin:3px 0 0;color:#6d907a}.schedule.inactive{background:#f4f5f3;color:#747d73}.task-copy{color:#8c968e;font-size:12px;margin:0 0 18px}.task-buttons{display:grid;grid-template-columns:1.2fr 1fr;gap:12px}.task-hint{margin-top:11px;font-size:10px;color:#9a9f98}.recent-run{display:flex;align-items:flex-start;gap:15px;justify-content:space-between;margin-top:auto;padding-top:23px;border-top:1px solid var(--line)}.task-panel{display:flex;flex-direction:column}.recent-copy strong{display:block;font-size:12px;font-weight:600}.recent-copy span{font-size:11px;color:#8f9891;display:block;margin-top:5px}.text-link{font-size:11px;color:var(--green);display:inline-flex;gap:6px;align-items:center;white-space:nowrap}.text-link .icon{width:13px;height:13px}.log-panel{padding-bottom:20px}.log-tools{display:flex;align-items:center;gap:13px}.log-meta{font-size:11px;color:#939c96}.log-tools .button{padding:7px 11px;min-height:33px;font-size:11px}.log-window{background:#252d31;color:#c1d1c8;border-radius:9px;padding:18px 20px;max-height:355px;min-height:155px;overflow:auto;margin:0;font:11px/1.95 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono","Microsoft YaHei",monospace;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:4;scrollbar-color:#53615a transparent}.page-footer{display:flex;justify-content:space-between;padding:18px 2px 0;font-size:10px;color:#a0a8a2;gap:12px}.toast{position:fixed;bottom:24px;left:calc(50% + 90px);transform:translate(-50%,15px);background:#273c2f;color:white;padding:11px 19px;border-radius:9px;box-shadow:0 8px 32px #18352422;z-index:40;font-size:12px;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;max-width:calc(100vw - 30px)}.toast.show{opacity:1;transform:translate(-50%,0)}.toast.error{background:#9e4946}.refreshing .icon{animation:spin 1.2s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.login-page{min-height:100vh;min-height:100svh;display:flex;align-items:center;justify-content:center;padding:30px 20px;background:#f5f7f9}.login-layout{width:100%;max-width:900px;display:grid;grid-template-columns:1fr 1fr;gap:72px;align-items:center}.login-intro .brand{padding:0;margin-bottom:45px}.login-intro h1{font-size:34px;letter-spacing:-1.1px;line-height:1.6;margin:0 0 15px;font-weight:650}.login-intro h1 span{color:var(--green)}.login-intro p{color:#8a948d;font-size:13px;line-height:1.9;margin:0;max-width:310px}.login-points{display:flex;gap:18px;margin-top:31px;font-size:11px;color:#8c978e}.login-points span{display:flex;align-items:center;gap:5px}.login-points .icon{width:14px;height:14px;color:#79a689}.login-card{background:#fff;border:1px solid var(--line);box-shadow:0 10px 45px #243f3008;border-radius:20px;padding:38px 32px}.login-card .login-emblem{width:43px;height:43px;display:grid;place-items:center;background:var(--green-soft);color:var(--green);border-radius:12px;margin-bottom:24px}.login-card h2{font-size:23px;margin:0 0 5px;letter-spacing:-.6px}.login-card>p{font-size:12px;color:#929c95;margin:0 0 27px}.login-card .field input{font-size:14px;height:45px}.login-card .button{margin-top:18px;min-height:44px;font-size:13px}.login-footnote{border-top:1px solid var(--line);margin-top:26px;padding-top:19px;text-align:center;font-size:10px;color:#9fa7a1}.password-wrap{position:relative}.password-wrap input{padding-right:45px}.password-toggle{position:absolute;right:4px;top:3px;width:38px;height:38px;border:0;background:none;color:#8a9a8e;display:grid;place-items:center}.login-card .password-toggle{margin:0;min-height:0;padding:0}.login-card .feedback{margin-bottom:0}.login-site-footer{position:absolute;bottom:22px;color:#abb2ac;font-size:10px;left:0;right:0;text-align:center}
@media(min-width:1750px){.main{margin-right:auto;margin-left:auto;padding-left:262px;max-width:1830px}}
@media(max-width:1150px){.sidebar{width:194px;padding-left:14px;padding-right:14px}.brand strong{font-size:20px}.main{margin-left:194px;padding-left:24px;padding-right:24px}.stat{padding:18px 13px;gap:9px}.stat-icon{width:31px;height:31px}.stat-value{font-size:21px}.stat-caption{font-size:10px}.panel{padding:20px}.content-grid{gap:17px}.account-row{gap:8px}.heading-row h1{font-size:23px}}
@media(max-width:950px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.content-grid{grid-template-columns:1fr}.task-panel{min-height:325px}.recent-run{margin-top:22px}.stat{min-height:114px}.login-layout{gap:40px;max-width:790px}.login-intro h1{font-size:30px}}
@media(max-width:680px){html{scroll-padding-top:126px}.sidebar{position:sticky;top:0;width:auto;border-right:0;border-bottom:1px solid var(--line);padding:15px 18px 10px;gap:14px;background:#fffffff5;backdrop-filter:blur(12px)}.brand{padding:0;gap:8px}.brand-mark{width:29px;height:32px}.brand-mark svg{width:28px;height:28px}.brand strong{font-size:20px}.brand small{font-size:10px;margin-top:0}.navigation{display:flex;margin-top:0;gap:8px}.nav-link{font-size:12px;padding:8px 12px;gap:7px;flex:1;justify-content:center}.nav-link .icon{width:16px;height:16px}.sidebar-bottom{display:none}.main{margin-left:0;padding:0 18px 20px}.topbar{height:51px}.topbar-right{gap:10px;font-size:10px}.avatar{width:26px;height:26px;font-size:12px}.breadcrumbs{font-size:10px;gap:9px}.heading-row{padding:23px 0 21px;align-items:flex-start;gap:12px}.heading-row h1{font-size:21px;line-height:1.55;letter-spacing:-.5px}.heading-row p{font-size:11px;max-width:235px;line-height:1.9}.heading-row>.button{font-size:0;width:36px;min-height:36px;padding:7px;flex-shrink:0;margin-top:5px}.heading-row>.button .icon{width:17px;height:17px}.stats{gap:11px;margin-bottom:16px}.stat{padding:16px 12px;gap:9px;min-height:115px}.stat-icon{width:28px;height:28px;border-radius:8px}.stat-icon .icon{width:17px;height:17px}.stat-label{font-size:10px}.stat-value{font-size:20px;min-height:29px}.stat-value.numeric{font-size:25px}.stat-caption{font-size:9px}.content-grid{gap:16px;margin-bottom:16px}.panel{border-radius:13px;padding:19px 17px;scroll-margin-top:137px}.panel-heading h2{font-size:15px}.account-name{font-size:12px}.account-token{font-size:10px}.account-row .badge{font-size:10px}.field input{font-size:16px;height:42px}.field-row>.button{font-size:11px;min-height:42px;padding:8px 11px}.field label{font-size:11px}.button{min-height:41px}.log-tools{gap:8px}.log-meta{display:none}.log-window{padding:14px 12px;font-size:10px;max-height:360px;min-height:180px}.page-footer{font-size:9px}.toast{left:50%;bottom:18px}.login-layout{display:block;max-width:385px}.login-intro .brand{margin:0 0 30px;justify-content:center}.login-intro h1,.login-intro>p,.login-points{display:none}.login-card{padding:29px 24px}.login-card h2{font-size:21px}.login-site-footer{position:static;margin-top:25px}.login-page{display:flex;flex-direction:column;padding:35px 20px}.login-card .field input{font-size:16px}.login-intro .brand strong{font-size:24px}.login-intro .brand small{font-size:11px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*:before,*:after{animation:none!important;transition:none!important}}
</style></head>
<body><svg class="svg-library" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs>
<symbol id="i-home" viewBox="0 0 24 24"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/></symbol>
<symbol id="i-user" viewBox="0 0 24 24"><circle cx="12" cy="7" r="4"/><path d="M4 21v-3a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v3"/></symbol>
<symbol id="i-log" viewBox="0 0 24 24"><rect x="5" y="3" width="15" height="18" rx="2"/><path d="M9 8h7M9 12h7M9 16h4M2 7h3M2 12h3M2 17h3"/></symbol>
<symbol id="i-calendar" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v5m10-5v5M3 11h18"/></symbol>
<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></symbol>
<symbol id="i-pulse" viewBox="0 0 24 24"><path d="M2 12h5l3-8 4 16 3-8h5"/></symbol>
<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 7A9 9 0 1 0 21 15M20 3v5h-5"/></symbol>
<symbol id="i-arrow" viewBox="0 0 24 24"><path d="M4 12h16m-6-6 6 6-6 6"/></symbol>
<symbol id="i-lock" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></symbol>
<symbol id="i-eye" viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></symbol>
<symbol id="i-play" viewBox="0 0 24 24"><path d="m8 5 11 7-11 7Z"/></symbol>
<symbol id="i-leaf" viewBox="0 0 36 36"><path fill="currentColor" stroke="none" d="M30.8 3.2c-2.8 5-6.8 4.1-14.2 5.4C7.8 10.2 5 17.7 7.4 24.7c2.5-5.6 7.1-9.2 13.4-11.5-6.6 3.8-10 8.2-12.3 14.1l-1 4.4 2.5-.5c.5-4.7 2.7-5.8 6.4-6.8 10.6-2.9 15.6-8.7 14.4-21.2Z"/></symbol>
</defs></svg>

<aside class="sidebar" aria-label="主导航">
  <a class="brand" href="#overview" aria-label="WorkBuddy 总览"><span class="brand-mark"><svg class="icon" aria-hidden="true"><use href="#i-leaf"/></svg></span><span><strong>WorkBuddy</strong><small>每日任务管理</small></span></a>
  <nav class="navigation"><a class="nav-link active" href="#overview" aria-current="page"><svg class="icon" aria-hidden="true"><use href="#i-home"/></svg>总览</a><a class="nav-link" href="#accounts"><svg class="icon" aria-hidden="true"><use href="#i-user"/></svg>账号管理</a><a class="nav-link" href="#logs"><svg class="icon" aria-hidden="true"><use href="#i-log"/></svg>运行日志</a></nav>
  <div class="sidebar-bottom"><div class="service-indicator" role="status"><span id="serviceDot" class="dot"></span><span id="serviceText">正在连接服务</span></div><div class="sidebar-note">WORKBUDDY DAILY · 国内版</div></div>
</aside>
<main class="main" id="overview">
  <header class="topbar"><div class="breadcrumbs"><span>工作台</span><span>/</span><strong id="breadcrumb">总览</strong></div><div class="topbar-right"><time id="today"></time><span class="avatar" aria-label="WorkBuddy">W</span></div></header>
  <div class="heading-row"><div><h1>一切就绪，今天也轻松一点。</h1><p>账号、定时任务与运行记录，在这里一目了然。</p></div><button class="button" id="refreshStatus" type="button" aria-label="刷新状态"><svg class="icon" aria-hidden="true"><use href="#i-refresh"/></svg><span>刷新状态</span></button></div>
  <section class="stats" aria-label="任务概况" aria-busy="true" id="stats">
    <div class="stat"><span class="stat-icon"><svg class="icon" aria-hidden="true"><use href="#i-user"/></svg></span><div><div class="stat-label">已配置账号</div><div class="stat-value numeric" id="accountCount">—</div><div class="stat-caption">凭据保存在服务器</div></div></div>
    <div class="stat"><span class="stat-icon"><svg class="icon" aria-hidden="true"><use href="#i-calendar"/></svg></span><div><div class="stat-label">定时任务</div><div class="stat-value"><span class="dot" id="timerDot"></span><span id="timerState">读取中</span></div><div class="stat-caption" id="timerCaption">正在获取任务状态</div></div></div>
    <div class="stat"><span class="stat-icon"><svg class="icon" aria-hidden="true"><use href="#i-clock"/></svg></span><div><div class="stat-label">下次运行</div><div class="stat-value numeric" id="nextTime">—</div><div class="stat-caption" id="nextCaption">北京时间</div></div></div>
    <div class="stat"><span class="stat-icon"><svg class="icon" aria-hidden="true"><use href="#i-pulse"/></svg></span><div><div class="stat-label">当前状态</div><div class="stat-value" id="runningState">读取中</div><div class="stat-caption" id="runningCaption">正在连接服务</div></div></div>
  </section>
  <div class="content-grid">
    <section class="panel" id="accounts" aria-labelledby="accountsTitle"><div class="panel-heading"><h2 id="accountsTitle">账号管理</h2><span class="badge" id="accountBadge">正在读取</span></div>
      <ul class="account-list" id="accountList"><li class="empty">正在读取已配置账号…</li></ul>
      <form id="accountForm" novalidate><div class="field-row"><div class="field"><label for="phone">手机号</label><input id="phone" name="phone" type="tel" inputmode="numeric" maxlength="11" placeholder="请输入手机号" autocomplete="tel" aria-describedby="loginMsg"></div><button class="button outline" id="btnSms" type="button">获取验证码</button></div>
      <div class="field-row"><div class="field"><label for="code">验证码</label><input id="code" name="code" type="text" inputmode="numeric" maxlength="6" placeholder="请输入短信验证码" autocomplete="one-time-code" aria-describedby="loginMsg"></div></div>
      <div class="feedback" id="loginMsg" role="status" aria-live="polite"></div><button class="button primary wide" id="btnLogin" type="submit">登录并保存账号</button><p class="form-note">验证码 5 分钟内有效。令牌只保存在服务器，不会显示在页面中。</p></form>
    </section>
    <section class="panel task-panel" aria-labelledby="tasksTitle"><div class="panel-heading"><h2 id="tasksTitle">任务操作</h2><span class="badge neutral" id="taskBadge">待命</span></div>
      <div class="schedule" id="scheduleBox"><svg class="icon" aria-hidden="true"><use href="#i-calendar"/></svg><div><strong id="scheduleTitle">正在获取定时任务</strong><p id="scheduleDetail">请稍候，马上就绪</p></div></div>
      <p class="task-copy">先查看状态，再开始新一轮任务。</p><div class="task-buttons"><button class="button primary run-button" id="btnRun" type="button" disabled><svg class="icon" aria-hidden="true"><use href="#i-play"/></svg>运行完整任务</button><button class="button run-button" id="btnQuery" type="button" disabled>只读查询</button></div>
      <p class="task-hint">完整任务会执行签到与成长任务，首次使用建议先只读查询。</p><div class="feedback" id="runMsg" role="status" aria-live="polite"></div>
      <div class="recent-run"><div class="recent-copy"><strong>最近运行</strong><span id="lastRun">正在读取…</span><span id="lastSummary"></span></div><a class="text-link" href="#logs">查看运行日志<svg class="icon" aria-hidden="true"><use href="#i-arrow"/></svg></a></div>
    </section>
  </div>
  <section class="panel log-panel" id="logs" aria-labelledby="logsTitle"><div class="panel-heading"><h2 id="logsTitle">运行日志</h2><div class="log-tools"><span class="log-meta">最近 200 行</span><button class="button" id="refreshLog" type="button"><svg class="icon" aria-hidden="true"><use href="#i-refresh"/></svg>刷新日志</button></div></div><pre class="log-window" id="log" tabindex="0" aria-label="最近运行日志">正在读取日志…</pre></section>
  <footer class="page-footer"><span>WorkBuddy Daily · 国内版签到管理</span><span id="updatedAt">正在同步状态</span></footer>
</main><div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let status = null, connected = false, submitting = false, statusLoading = false, logLoading = false;
  let toastTimer, cooldownTimer, cooldownUntil = 0, pollTick = 0;
  const phoneValid = value => /^1[3-9]\d{9}$/.test(value);
  const icon = name => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', '#i-' + name); svg.append(use); return svg;
  };
  function toast(text, error = false) {
    $('toast').textContent = text; $('toast').className = 'toast show' + (error ? ' error' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3500);
  }
  function message(id, text, type = 'info') {
    $(id).className = 'feedback ' + type; $(id).textContent = text;
  }
  async function api(path, data, plain = false) {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(path, {cache: 'no-store', signal: controller.signal, ...(data === undefined ? {} : {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)
      })});
      if (response.status === 401) { window.location.replace('/login'); throw new Error('登录已过期，请重新进入控制台'); }
      if (!response.ok) throw new Error('请求失败，请稍后重试（' + response.status + '）');
      if (plain) return await response.text();
      const result = await response.json();
      if (result.ok === false) throw new Error(result.error || '操作未完成，请重试');
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时，请检查网络后重试');
      if (error instanceof TypeError) throw new Error('暂时无法连接服务，请稍后重试');
      if (error instanceof SyntaxError) throw new Error('服务响应异常，请刷新页面重试');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function updateBusy() {
    const busy = submitting || Boolean(status?.running);
    document.querySelectorAll('.run-button').forEach(button => { button.disabled = busy || !connected || !status?.accounts?.length; });
    $('taskBadge').textContent = !connected ? '未连接' : status?.running ? '运行中' : '待命';
    $('taskBadge').className = 'badge ' + (status?.running ? 'warn' : 'neutral');
    $('btnRun').setAttribute('aria-busy', String(submitting));
  }
  function renderAccounts(accounts, states) {
    $('accountList').replaceChildren();
    $('accountCount').textContent = String(accounts.length).padStart(2, '0');
    $('accountBadge').textContent = accounts.length + ' 个账号';
    if (!accounts.length) {
      const empty = document.createElement('li'); empty.className = 'empty';
      empty.textContent = '还没有配置账号。通过下方短信登录，添加第一个账号。'; $('accountList').append(empty); return;
    }
    for (const account of accounts) {
      const row = document.createElement('li'); row.className = 'account-row';
      const avatar = document.createElement('span'); avatar.className = 'account-avatar'; avatar.append(icon('user'));
      const info = document.createElement('div'); info.className = 'account-info';
      const name = document.createElement('div'); name.className = 'account-name'; name.textContent = account;
      const tokens = document.createElement('div'); tokens.className = 'account-token';
      const record = states.find(item => item.account === account);
      tokens.textContent = record ? '访问令牌 · ' + (record.has_at ? '已保存' : '待刷新') + ' / 刷新令牌 · ' + (record.has_rt ? '已保存' : '待刷新') : '账号凭据 · 已保存';
      const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = '已配置';
      info.append(name, tokens); row.append(avatar, info, badge); $('accountList').append(row);
    }
  }
  async function loadStatus() {
    if (statusLoading) return;
    statusLoading = true;
    try {
      const data = await api('/api/status'); status = data; connected = true;
      const timer = data.timer || {}, active = timer.active === 'active', enabled = timer.enabled === 'enabled';
      renderAccounts(Array.isArray(data.accounts) ? data.accounts : [], data.state || []);
      $('timerState').textContent = active ? (enabled ? '已启用' : '已启动') : '未运行';
      $('timerDot').className = 'dot' + (active ? '' : ' warn');
      $('timerCaption').textContent = enabled ? '已设为开机自动启用' : '未设为开机自动启用';
      const timeMatch = String(timer.next || '').match(/\d{2}:\d{2}(?::\d{2})?/);
      $('nextTime').textContent = timeMatch ? timeMatch[0].slice(0, 5) : '—';
      $('nextCaption').textContent = timeMatch ? String(timer.next).replace(timeMatch[0], '').trim() + ' · 北京时间' : '暂无已安排的运行';
      $('runningState').textContent = data.running ? '运行中' : '空闲';
      $('runningCaption').textContent = data.running ? '任务正在后台执行' : '等待下一次任务';
      $('scheduleTitle').textContent = active ? '定时任务已就绪' : '定时任务未运行';
      $('scheduleDetail').textContent = active && timer.next ? '下次执行：' + timer.next + '（北京时间）' : '暂未安排自动执行，请检查服务端定时配置';
      $('scheduleBox').classList.toggle('inactive', !active);
      const last = data.last_run || {};
      $('lastRun').textContent = last.at || '暂无运行记录'; $('lastSummary').textContent = last.at ? (last.summary || '查看详细日志了解执行情况') : '';
      $('serviceDot').className = 'dot'; $('serviceText').textContent = '服务连接正常';
      $('updatedAt').textContent = '状态更新于 ' + new Date().toLocaleTimeString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false});
    } catch (error) {
      connected = false; $('serviceDot').className = 'dot offline'; $('serviceText').textContent = '连接暂时中断';
      $('updatedAt').textContent = error.message;
      if (!status) { $('runningState').textContent = '未连接'; $('runningCaption').textContent = '请刷新状态后重试'; $('accountList').textContent = '暂时无法读取账号，请刷新状态重试。'; }
      throw error;
    } finally { statusLoading = false; $('stats').setAttribute('aria-busy', 'false'); updateBusy(); }
  }
  async function loadLog() {
    if (logLoading) return;
    logLoading = true;
    try {
      const text = await api('/api/log?n=200', undefined, true);
      const log = $('log'), nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 45;
      if (log.textContent !== text) { log.textContent = text || '暂时没有日志，运行任务后将在这里显示。'; if (nearBottom) log.scrollTop = log.scrollHeight; }
    } finally { logLoading = false; }
  }
  function countdown() {
    const left = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
    $('btnSms').disabled = left > 0; $('btnSms').textContent = left ? left + ' 秒后重发' : '获取验证码';
    if (!left) clearInterval(cooldownTimer);
  }
  async function sendSms() {
    const phone = $('phone').value.trim(), button = $('btnSms');
    if (!phoneValid(phone)) { message('loginMsg', '请输入正确的 11 位手机号。', 'err'); $('phone').focus(); return; }
    button.disabled = true; button.textContent = '发送中…'; message('loginMsg', '正在发送验证码…');
    try {
      await api('/api/send-sms', {phone}); message('loginMsg', '验证码已发送，请查收短信。', 'ok');
      cooldownUntil = Date.now() + 60000; clearInterval(cooldownTimer); countdown(); cooldownTimer = setInterval(countdown, 1000); $('code').focus();
    } catch (error) { message('loginMsg', error.message, 'err'); button.disabled = false; button.textContent = '获取验证码'; }
  }
  async function login(event) {
    event.preventDefault();
    const phone = $('phone').value.trim(), code = $('code').value.trim(), button = $('btnLogin');
    if (!phoneValid(phone)) { message('loginMsg', '请输入正确的 11 位手机号。', 'err'); $('phone').focus(); return; }
    if (!/^\d{6}$/.test(code)) { message('loginMsg', '请输入 6 位短信验证码。', 'err'); $('code').focus(); return; }
    button.disabled = true; button.textContent = '正在登录…';
    try {
      const data = await api('/api/login', {phone, code}); $('code').value = '';
      message('loginMsg', '登录成功，已保存 ' + data.count + ' 个账号。', 'ok');
      await loadStatus().catch(error => toast(error.message, true));
    } catch (error) { message('loginMsg', error.message, 'err'); }
    finally { button.disabled = false; button.textContent = '登录并保存账号'; }
  }
  async function run(args) {
    if (submitting || status?.running || !connected || !status?.accounts?.length) return;
    if (!args && !confirm('将为所有已配置账号执行签到与成长任务。\n\n确认开始运行完整任务吗？')) return;
    submitting = true; updateBusy(); message('runMsg', '正在提交任务…');
    try {
      await api('/api/run', {args}); status.running = true;
      message('runMsg', args ? '只读查询已启动，执行结果会显示在下方日志。' : '完整任务已启动，可能需要几分钟。', 'ok');
      $('runningState').textContent = '运行中'; $('runningCaption').textContent = '任务正在后台执行';
      setTimeout(() => { loadStatus().catch(() => {}); loadLog().catch(() => {}); }, 2000);
    } catch (error) { message('runMsg', error.message, 'err'); }
    finally { submitting = false; updateBusy(); }
  }
  function activate(hash) {
    document.querySelectorAll('.nav-link').forEach(link => {
      const selected = link.getAttribute('href') === hash;
      link.classList.toggle('active', selected);
      if (selected) { link.setAttribute('aria-current', 'page'); $('breadcrumb').textContent = link.textContent; }
      else link.removeAttribute('aria-current');
    });
  }
  document.querySelectorAll('a[href^="#"]').forEach(link => link.addEventListener('click', () => activate(link.getAttribute('href'))));
  window.addEventListener('hashchange', () => activate(location.hash || '#overview'));
  $('refreshStatus').addEventListener('click', async () => {
    const button = $('refreshStatus'); button.disabled = true; button.classList.add('refreshing');
    try { await loadStatus(); toast('状态已更新'); } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; button.classList.remove('refreshing'); }
  });
  $('refreshLog').addEventListener('click', async () => {
    const button = $('refreshLog'); button.disabled = true; button.classList.add('refreshing');
    try { await loadLog(); toast('日志已更新'); } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; button.classList.remove('refreshing'); }
  });
  $('btnSms').addEventListener('click', sendSms); $('accountForm').addEventListener('submit', login);
  $('btnRun').addEventListener('click', () => run('')); $('btnQuery').addEventListener('click', () => run('--query'));
  $('today').textContent = new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric'}).format(new Date());
  activate(location.hash || '#overview');
  loadStatus().catch(error => toast(error.message, true)); loadLog().catch(error => { $('log').textContent = error.message; });
  setInterval(() => {
    pollTick++; if (document.hidden || (!status?.running && pollTick % 6)) return;
    loadStatus().catch(() => {}); loadLog().catch(() => {});
  }, 5000);
})();
</script></body></html>
"""

LOGIN_PAGE = r"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#247b59"><meta name="color-scheme" content="light"><title>登录 · WorkBuddy 控制台</title><style>:root{--bg:#f5f7f9;--surface:#fff;--text:#202c2b;--muted:#7a8583;--line:#e7ecea;--green:#247b59;--green-dark:#196244;--green-soft:#eaf5ee;--red:#c24545;--shadow:0 3px 16px #203b2d04;--radius:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--text);background:var(--bg);font-synthesis:none}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;font-size:14px;line-height:1.6}button,input{font:inherit}button,a,input{-webkit-tap-highlight-color:transparent}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.55}a{color:inherit;text-decoration:none}button,a,input{outline-offset:4px}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #80b99d}.icon{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}.svg-library{position:absolute;width:0;height:0;overflow:hidden}.sidebar{position:fixed;inset:0 auto 0 0;width:226px;display:flex;flex-direction:column;padding:32px 19px 22px;background:#fff;border-right:1px solid var(--line);z-index:10}.brand{display:flex;align-items:center;gap:11px;padding:0 7px}.brand-mark{display:grid;place-items:center;width:36px;height:42px;color:var(--green)}.brand-mark svg{width:35px;height:35px}.brand strong{font-size:22px;letter-spacing:-.8px;display:block;line-height:1.3;color:#172c23}.brand small{display:block;color:var(--muted);font-size:12px;margin-top:4px;letter-spacing:1px}.navigation{display:grid;gap:9px;margin-top:47px}.nav-link{display:flex;align-items:center;gap:12px;padding:12px 15px;color:#79827e;border-radius:9px;font-weight:500;transition:background .15s,color .15s}.nav-link:hover{background:#f4f8f5;color:var(--green)}.nav-link.active{background:var(--green-soft);color:var(--green-dark);font-weight:650}.sidebar-bottom{margin-top:auto;color:var(--muted);font-size:12px;padding:20px 10px 0}.service-indicator{display:flex;align-items:center;gap:8px}.dot{display:inline-block;background:#369b6a;width:7px;height:7px;border-radius:50%;flex-shrink:0}.dot.warn{background:#d49a36}.dot.offline{background:#bd6969}.sidebar-note{font-size:11px;color:#a2aaa5;margin-top:8px}.main{margin-left:226px;padding:0 36px 24px;max-width:1640px}.topbar{height:77px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:12px}.breadcrumbs{font-size:12px;display:flex;gap:13px;color:var(--muted)}.breadcrumbs strong{color:#4a5550;font-weight:500}.topbar-right{display:flex;align-items:center;gap:18px;color:var(--muted);font-size:12px}.avatar{border-radius:50%;display:grid;place-items:center;background:var(--green);color:white;width:31px;height:31px;font-weight:600;font-size:14px}.heading-row{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:30px 0 25px}.heading-row h1{font-size:25px;letter-spacing:-.8px;margin:0 0 7px;line-height:1.45;font-weight:700}.heading-row p{margin:0;color:var(--muted);font-size:13px}.button{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--line);border-radius:8px;background:#fff;color:#55645c;padding:9px 15px;font-size:12px;font-weight:550;min-height:39px;white-space:nowrap;transition:background .15s,transform .15s}.button:hover:not(:disabled){background:#f4f8f5;border-color:#cadbd0}.button:active:not(:disabled){transform:translateY(1px)}.button .icon{width:16px;height:16px}.button.primary{background:var(--green);border-color:var(--green);color:#fff}.button.primary:hover:not(:disabled){background:var(--green-dark)}.button.outline{border-color:#c2d8cc;color:var(--green)}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:15px;margin-bottom:23px}.stat{background:white;border:1px solid var(--line);box-shadow:var(--shadow);border-radius:var(--radius);padding:22px 16px;display:flex;gap:13px;min-height:122px}.stat-icon{background:#edf7f0;color:var(--green);width:38px;height:38px;border-radius:10px;display:grid;place-items:center;flex-shrink:0}.stat-label{font-size:12px;color:#6d7972;margin-bottom:5px}.stat-value{display:flex;align-items:center;gap:8px;font-weight:650;font-size:24px;color:#26382d;letter-spacing:-.7px;line-height:1.35;min-height:33px;font-variant-numeric:tabular-nums}.stat-value.numeric{font-size:29px}.stat-caption{font-size:11px;color:#929c95;margin-top:5px}.content-grid{display:grid;grid-template-columns:minmax(0,1.12fr) minmax(0,1fr);gap:22px;align-items:stretch;margin-bottom:23px}.panel{background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow);border-radius:var(--radius);padding:23px 24px;scroll-margin-top:24px;min-width:0}.panel-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.panel-heading h2{font-size:16px;letter-spacing:-.3px;margin:0;font-weight:650}.badge{display:inline-flex;align-items:center;gap:6px;border-radius:5px;background:var(--green-soft);color:var(--green);font-size:11px;line-height:1.5;padding:3px 8px;white-space:nowrap}.badge.neutral{color:#879088;background:#f2f5f3}.badge.warn{background:#fff5df;color:#a2771a}.badge.error{background:#fbeeee;color:var(--red)}.account-list{margin:0 0 19px;padding:0;list-style:none;border-bottom:1px solid var(--line);padding-bottom:13px}.account-row{display:flex;align-items:center;gap:11px;padding:12px 0}.account-row+.account-row{border-top:1px solid #f1f4f2}.account-avatar{width:33px;height:33px;border-radius:50%;background:#edf6f0;color:#7baf91;display:grid;place-items:center;flex-shrink:0}.account-name{font-size:13px;font-weight:600;letter-spacing:.3px}.account-token{font-size:10px;color:#8f9891;margin-top:2px}.account-info{flex:1;min-width:0}.empty{color:var(--muted);font-size:12px;padding:22px 0;line-height:1.9}.field-row{display:flex;gap:10px;align-items:flex-end;margin-bottom:12px}.field{display:flex;flex-direction:column;gap:6px;flex:1;min-width:0}.field label{font-size:11px;color:#5c6a61;font-weight:550}.field input{width:100%;height:39px;border:1px solid #dbe4de;border-radius:7px;padding:8px 12px;min-width:0;background:#fff;color:var(--text);font-size:12px;transition:border-color .15s}.field input:focus{border-color:#69a485}.field input::placeholder{color:#adb5af}.wide{width:100%}.form-note{margin:10px 0 0;font-size:10px;color:#969e98;line-height:1.8}.feedback{font-size:12px;line-height:1.7}.feedback:not(:empty){padding:9px 11px;border-radius:7px;margin:10px 0;background:#eef5f0}.feedback.err{color:#ac4545;background:#fff1f1}.feedback.ok{color:var(--green)}.feedback.info{color:#69796f}.feedback:empty{display:none}.schedule{display:flex;align-items:center;gap:12px;background:#edf7f0;border-radius:10px;padding:16px;margin:19px 0 15px;color:var(--green)}.schedule .icon{width:25px;height:25px}.schedule strong{font-size:13px;font-weight:600;display:block}.schedule p{font-size:11px;margin:3px 0 0;color:#6d907a}.schedule.inactive{background:#f4f5f3;color:#747d73}.task-copy{color:#8c968e;font-size:12px;margin:0 0 18px}.task-buttons{display:grid;grid-template-columns:1.2fr 1fr;gap:12px}.task-hint{margin-top:11px;font-size:10px;color:#9a9f98}.recent-run{display:flex;align-items:flex-start;gap:15px;justify-content:space-between;margin-top:auto;padding-top:23px;border-top:1px solid var(--line)}.task-panel{display:flex;flex-direction:column}.recent-copy strong{display:block;font-size:12px;font-weight:600}.recent-copy span{font-size:11px;color:#8f9891;display:block;margin-top:5px}.text-link{font-size:11px;color:var(--green);display:inline-flex;gap:6px;align-items:center;white-space:nowrap}.text-link .icon{width:13px;height:13px}.log-panel{padding-bottom:20px}.log-tools{display:flex;align-items:center;gap:13px}.log-meta{font-size:11px;color:#939c96}.log-tools .button{padding:7px 11px;min-height:33px;font-size:11px}.log-window{background:#252d31;color:#c1d1c8;border-radius:9px;padding:18px 20px;max-height:355px;min-height:155px;overflow:auto;margin:0;font:11px/1.95 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono","Microsoft YaHei",monospace;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:4;scrollbar-color:#53615a transparent}.page-footer{display:flex;justify-content:space-between;padding:18px 2px 0;font-size:10px;color:#a0a8a2;gap:12px}.toast{position:fixed;bottom:24px;left:calc(50% + 90px);transform:translate(-50%,15px);background:#273c2f;color:white;padding:11px 19px;border-radius:9px;box-shadow:0 8px 32px #18352422;z-index:40;font-size:12px;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;max-width:calc(100vw - 30px)}.toast.show{opacity:1;transform:translate(-50%,0)}.toast.error{background:#9e4946}.refreshing .icon{animation:spin 1.2s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.login-page{min-height:100vh;min-height:100svh;display:flex;align-items:center;justify-content:center;padding:30px 20px;background:#f5f7f9}.login-layout{width:100%;max-width:900px;display:grid;grid-template-columns:1fr 1fr;gap:72px;align-items:center}.login-intro .brand{padding:0;margin-bottom:45px}.login-intro h1{font-size:34px;letter-spacing:-1.1px;line-height:1.6;margin:0 0 15px;font-weight:650}.login-intro h1 span{color:var(--green)}.login-intro p{color:#8a948d;font-size:13px;line-height:1.9;margin:0;max-width:310px}.login-points{display:flex;gap:18px;margin-top:31px;font-size:11px;color:#8c978e}.login-points span{display:flex;align-items:center;gap:5px}.login-points .icon{width:14px;height:14px;color:#79a689}.login-card{background:#fff;border:1px solid var(--line);box-shadow:0 10px 45px #243f3008;border-radius:20px;padding:38px 32px}.login-card .login-emblem{width:43px;height:43px;display:grid;place-items:center;background:var(--green-soft);color:var(--green);border-radius:12px;margin-bottom:24px}.login-card h2{font-size:23px;margin:0 0 5px;letter-spacing:-.6px}.login-card>p{font-size:12px;color:#929c95;margin:0 0 27px}.login-card .field input{font-size:14px;height:45px}.login-card .button{margin-top:18px;min-height:44px;font-size:13px}.login-footnote{border-top:1px solid var(--line);margin-top:26px;padding-top:19px;text-align:center;font-size:10px;color:#9fa7a1}.password-wrap{position:relative}.password-wrap input{padding-right:45px}.password-toggle{position:absolute;right:4px;top:3px;width:38px;height:38px;border:0;background:none;color:#8a9a8e;display:grid;place-items:center}.login-card .password-toggle{margin:0;min-height:0;padding:0}.login-card .feedback{margin-bottom:0}.login-site-footer{position:absolute;bottom:22px;color:#abb2ac;font-size:10px;left:0;right:0;text-align:center}
@media(min-width:1750px){.main{margin-right:auto;margin-left:auto;padding-left:262px;max-width:1830px}}
@media(max-width:1150px){.sidebar{width:194px;padding-left:14px;padding-right:14px}.brand strong{font-size:20px}.main{margin-left:194px;padding-left:24px;padding-right:24px}.stat{padding:18px 13px;gap:9px}.stat-icon{width:31px;height:31px}.stat-value{font-size:21px}.stat-caption{font-size:10px}.panel{padding:20px}.content-grid{gap:17px}.account-row{gap:8px}.heading-row h1{font-size:23px}}
@media(max-width:950px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.content-grid{grid-template-columns:1fr}.task-panel{min-height:325px}.recent-run{margin-top:22px}.stat{min-height:114px}.login-layout{gap:40px;max-width:790px}.login-intro h1{font-size:30px}}
@media(max-width:680px){html{scroll-padding-top:126px}.sidebar{position:sticky;top:0;width:auto;border-right:0;border-bottom:1px solid var(--line);padding:15px 18px 10px;gap:14px;background:#fffffff5;backdrop-filter:blur(12px)}.brand{padding:0;gap:8px}.brand-mark{width:29px;height:32px}.brand-mark svg{width:28px;height:28px}.brand strong{font-size:20px}.brand small{font-size:10px;margin-top:0}.navigation{display:flex;margin-top:0;gap:8px}.nav-link{font-size:12px;padding:8px 12px;gap:7px;flex:1;justify-content:center}.nav-link .icon{width:16px;height:16px}.sidebar-bottom{display:none}.main{margin-left:0;padding:0 18px 20px}.topbar{height:51px}.topbar-right{gap:10px;font-size:10px}.avatar{width:26px;height:26px;font-size:12px}.breadcrumbs{font-size:10px;gap:9px}.heading-row{padding:23px 0 21px;align-items:flex-start;gap:12px}.heading-row h1{font-size:21px;line-height:1.55;letter-spacing:-.5px}.heading-row p{font-size:11px;max-width:235px;line-height:1.9}.heading-row>.button{font-size:0;width:36px;min-height:36px;padding:7px;flex-shrink:0;margin-top:5px}.heading-row>.button .icon{width:17px;height:17px}.stats{gap:11px;margin-bottom:16px}.stat{padding:16px 12px;gap:9px;min-height:115px}.stat-icon{width:28px;height:28px;border-radius:8px}.stat-icon .icon{width:17px;height:17px}.stat-label{font-size:10px}.stat-value{font-size:20px;min-height:29px}.stat-value.numeric{font-size:25px}.stat-caption{font-size:9px}.content-grid{gap:16px;margin-bottom:16px}.panel{border-radius:13px;padding:19px 17px;scroll-margin-top:137px}.panel-heading h2{font-size:15px}.account-name{font-size:12px}.account-token{font-size:10px}.account-row .badge{font-size:10px}.field input{font-size:16px;height:42px}.field-row>.button{font-size:11px;min-height:42px;padding:8px 11px}.field label{font-size:11px}.button{min-height:41px}.log-tools{gap:8px}.log-meta{display:none}.log-window{padding:14px 12px;font-size:10px;max-height:360px;min-height:180px}.page-footer{font-size:9px}.toast{left:50%;bottom:18px}.login-layout{display:block;max-width:385px}.login-intro .brand{margin:0 0 30px;justify-content:center}.login-intro h1,.login-intro>p,.login-points{display:none}.login-card{padding:29px 24px}.login-card h2{font-size:21px}.login-site-footer{position:static;margin-top:25px}.login-page{display:flex;flex-direction:column;padding:35px 20px}.login-card .field input{font-size:16px}.login-intro .brand strong{font-size:24px}.login-intro .brand small{font-size:11px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*:before,*:after{animation:none!important;transition:none!important}}
</style></head>
<body class="login-page"><svg class="svg-library" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs>
<symbol id="i-home" viewBox="0 0 24 24"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/></symbol>
<symbol id="i-user" viewBox="0 0 24 24"><circle cx="12" cy="7" r="4"/><path d="M4 21v-3a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v3"/></symbol>
<symbol id="i-log" viewBox="0 0 24 24"><rect x="5" y="3" width="15" height="18" rx="2"/><path d="M9 8h7M9 12h7M9 16h4M2 7h3M2 12h3M2 17h3"/></symbol>
<symbol id="i-calendar" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v5m10-5v5M3 11h18"/></symbol>
<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></symbol>
<symbol id="i-pulse" viewBox="0 0 24 24"><path d="M2 12h5l3-8 4 16 3-8h5"/></symbol>
<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 7A9 9 0 1 0 21 15M20 3v5h-5"/></symbol>
<symbol id="i-arrow" viewBox="0 0 24 24"><path d="M4 12h16m-6-6 6 6-6 6"/></symbol>
<symbol id="i-lock" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></symbol>
<symbol id="i-eye" viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></symbol>
<symbol id="i-play" viewBox="0 0 24 24"><path d="m8 5 11 7-11 7Z"/></symbol>
<symbol id="i-leaf" viewBox="0 0 36 36"><path fill="currentColor" stroke="none" d="M30.8 3.2c-2.8 5-6.8 4.1-14.2 5.4C7.8 10.2 5 17.7 7.4 24.7c2.5-5.6 7.1-9.2 13.4-11.5-6.6 3.8-10 8.2-12.3 14.1l-1 4.4 2.5-.5c.5-4.7 2.7-5.8 6.4-6.8 10.6-2.9 15.6-8.7 14.4-21.2Z"/></symbol>
</defs></svg>
<main class="login-layout"><section class="login-intro"><div class="brand"><span class="brand-mark"><svg class="icon" aria-hidden="true"><use href="#i-leaf"/></svg></span><span><strong>WorkBuddy</strong><small>每日任务管理</small></span></div><h1>把重复的事交给它，<br><span>把时间留给自己。</span></h1><p>账号、每日任务与运行记录，<br>一个安静有序的工作台就够了。</p><div class="login-points"><span><svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>定时执行</span><span><svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>状态可查</span><span><svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>凭据本地保存</span></div></section>
<form class="login-card" method="post" action="/login"><span class="login-emblem"><svg class="icon" aria-hidden="true"><use href="#i-lock"/></svg></span><h2>欢迎回来</h2><p>输入访问口令，进入你的控制台。</p><div class="field"><label for="password">访问口令</label><div class="password-wrap"><input id="password" name="password" type="password" placeholder="请输入访问口令" autocomplete="current-password" required autofocus aria-describedby="loginError"><button class="password-toggle" type="button" id="togglePassword" aria-label="显示口令" aria-pressed="false"><svg class="icon" aria-hidden="true"><use href="#i-eye"/></svg></button></div></div><div class="feedback err" id="loginError" role="alert">__MSG__</div><button class="button primary wide" type="submit" id="enterButton">进入控制台<svg class="icon" aria-hidden="true"><use href="#i-arrow"/></svg></button><div class="login-footnote">仅限授权访问 · 账号凭据由服务器保管</div></form></main><footer class="login-site-footer">WorkBuddy Daily · 让每日任务井然有序</footer>
<script>document.getElementById('togglePassword').addEventListener('click',function(){const p=document.getElementById('password');const show=p.type==='password';p.type=show?'text':'password';this.setAttribute('aria-label',show?'隐藏口令':'显示口令');this.setAttribute('aria-pressed',String(show));});document.querySelector('form').addEventListener('submit',()=>{const b=document.getElementById('enterButton');b.disabled=true;b.textContent='正在进入…';});window.addEventListener('pageshow',()=>{const b=document.getElementById('enterButton');b.disabled=false;b.textContent='进入控制台';});</script></body></html>
"""


def mask_log(text):
    return text


class Handler(BaseHTTPRequestHandler):
    server_version = "wbpanel"
    sys_version = ""

    def log_message(self, fmt, *args):
        pass

    # ── 工具 ──
    def _send(self, code, body, ctype="text/plain; charset=utf-8", extra=None):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8")

    def _ip(self):
        return self.client_address[0]

    def _cookie_token(self):
        return "%d.%s" % (int(time.time()), hmac.new(SECRET.encode(), str(int(time.time())).encode(), "sha256").hexdigest())

    def _make_cookie(self):
        ts = str(int(time.time()))
        sig = hmac.new(SECRET.encode(), ts.encode(), "sha256").hexdigest()
        return "%s.%s" % (ts, sig)

    def _check_cookie(self):
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            k, _, v = part.strip().partition("=")
            if k != COOKIE or not v:
                continue
            ts, _, sig = v.partition(".")
            if not ts.isdigit() or not sig:
                return False
            want = hmac.new(SECRET.encode(), ts.encode(), "sha256").hexdigest()
            if not hmac.compare_digest(sig, want):
                return False
            if time.time() - int(ts) > SESSION_TTL:
                return False
            return True
        return False

    def _authed(self):
        return self._check_cookie()

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b""
            if (self.headers.get("Content-Type") or "").startswith("application/x-www-form-urlencoded"):
                return {k: v[0] for k, v in urllib.parse.parse_qs(raw.decode("utf-8")).items()}
            return json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return {}

    # ── 路由 ──
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/robots.txt":
            return self._send(200, "User-agent: *\nDisallow: /\n")
        if path == "/login":
            return self._send(200, LOGIN_PAGE.replace("__MSG__", ""), "text/html; charset=utf-8")
        if not self._authed():
            if path.startswith("/api/"):
                return self._json({"ok": False, "error": "未登录"}, 401)
            return self._send(200, LOGIN_PAGE.replace("__MSG__", ""), "text/html; charset=utf-8")
        if path == "/":
            return self._send(200, PAGE, "text/html; charset=utf-8")
        if path == "/api/status":
            return self._json({
                "ok": True,
                "accounts": read_accounts(),
                "state": state_info(),
                "timer": timer_info(),
                "last_run": last_run_meta(),
                "running": _run_state["running"],
            })
        if path == "/api/log":
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                n = min(2000, max(20, int((q.get("n") or ["200"])[0])))
            except Exception:
                n = 200
            return self._send(200, tail_log(n), "text/plain; charset=utf-8")
        return self._send(404, "not found")

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/login":
            body = self._body()
            pwd = (body.get("password") or "").strip()
            ip = self._ip()
            now = time.time()
            cnt, ts = _fail_state.get(ip, (0, now))
            if now - ts > 600:
                cnt = 0
            if cnt >= 10:
                return self._send(429, LOGIN_PAGE.replace("__MSG__", "尝试次数过多，请 10 分钟后再试"), "text/html; charset=utf-8")
            if not PASSWORD or not hmac.compare_digest(pwd, PASSWORD):
                _fail_state[ip] = (cnt + 1, now)
                time.sleep(0.4)
                return self._send(200, LOGIN_PAGE.replace("__MSG__", "口令不对"), "text/html; charset=utf-8")
            _fail_state.pop(ip, None)
            return self._send(302, "", extra={
                "Location": "/",
                "Set-Cookie": "%s=%s; Path=/; HttpOnly; SameSite=Strict; Max-Age=%d" % (COOKIE, self._make_cookie(), SESSION_TTL),
            })

        if not self._authed():
            return self._json({"ok": False, "error": "未登录"}, 401)

        if path == "/api/send-sms":
            body = self._body()
            phone = str(body.get("phone") or "").strip()
            if not PHONE_RE.match(phone):
                return self._json({"ok": False, "error": "手机号格式不对"})
            if time.time() - _sms_state["last"] < 55:
                left = int(55 - (time.time() - _sms_state["last"]))
                return self._json({"ok": False, "error": "发码太频繁，%d 秒后再试" % left})
            try:
                ok, msg = sms_send(phone)
            except Exception as e:
                return self._json({"ok": False, "error": "调用发码接口异常: %s" % str(e)[:80]})
            if ok:
                _sms_state["last"] = time.time()
                return self._json({"ok": True})
            return self._json({"ok": False, "error": str(msg)[:120]})

        if path == "/api/login":
            body = self._body()
            phone = str(body.get("phone") or "").strip()
            code = str(body.get("code") or "").strip()
            if not PHONE_RE.match(phone) or not code.isdigit():
                return self._json({"ok": False, "error": "手机号或验证码格式不对"})
            try:
                ok, res = sms_login(phone, code)
            except Exception as e:
                return self._json({"ok": False, "error": "登录异常: %s" % str(e)[:80]})
            if not ok:
                return self._json({"ok": False, "error": res[:160]})
            try:
                n = write_account(res)
            except Exception as e:
                return self._json({"ok": False, "error": "令牌已取到但写入失败: %s" % str(e)[:80]})
            return self._json({"ok": True, "count": n, "account": mask_phone(phone)})

        if path == "/api/run":
            body = self._body()
            args = str(body.get("args") or "").strip()
            if args not in ("", "--query", "--refresh"):
                return self._json({"ok": False, "error": "参数不支持"})
            if not read_accounts():
                return self._json({"ok": False, "error": "还没有令牌，先登录"})
            ok, msg = start_run(args)
            return self._json({"ok": ok, "error": "" if ok else msg})

        return self._json({"ok": False, "error": "not found"}, 404)


def main():
    if not PASSWORD:
        print("❌ 缺少 %s（访问口令）" % PASS_FILE)
        return 1
    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    print("WorkBuddy 控制台已启动: http://%s:%d" % (BIND, PORT), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
