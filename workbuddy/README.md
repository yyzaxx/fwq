# WorkBuddy Daily 与服务器控制台

本目录收录当前服务器使用的 WorkBuddy Daily v3.39 源码、国内与国际版登录工具、117项上游自动测试，以及服务器上的 `panel.py` 控制台和运行包装脚本。上游为 [L0NE-6/WorkBuddy-Daily](https://github.com/L0NE-6/WorkBuddy-Daily)，保留 `app/LICENSE`、`app/NOTICE.md`、作者署名和原始使用说明。本快照是服务器部署备份，不代表上游官方渠道。

## 安装

需要 Python 3.8+ 与 `requests`，服务器控制台仅使用 Python 标准库。从 fwq 仓库根目录在新机器执行：

```sh
install -d /opt/workbuddy
cp -a workbuddy/. /opt/workbuddy/
python3 -m pip install -r /opt/workbuddy/app/requirements.txt
install -d -m 0700 /opt/workbuddy/state /opt/workbuddy/logs
install -m 0600 workbuddy/workbuddy.env.example /opt/workbuddy/workbuddy.env
chmod 0755 /opt/workbuddy/run.sh /opt/workbuddy/login.sh /opt/workbuddy/status.sh
```

首次部署用新机器自己的控制台口令，不覆盖已有口令：

```sh
umask 077
test -s /opt/workbuddy/panel.password || python3 -c 'import secrets; print(secrets.token_urlsafe(24))' > /opt/workbuddy/panel.password
install -m 0644 workbuddy/deploy/workbuddy-panel.service.example /etc/systemd/system/workbuddy-panel.service
install -m 0644 workbuddy/deploy/workbuddy.service.example /etc/systemd/system/workbuddy.service
install -m 0644 workbuddy/deploy/workbuddy.timer.example /etc/systemd/system/workbuddy.timer
systemctl daemon-reload
systemctl enable --now workbuddy-panel.service
```

控制台默认端口8600，使用 `/opt/workbuddy/panel.password` 验证访问。其 HMAC 会话密钥会在本机生成到 `panel.secret`。按实际网络环境调整服务模板的 `PANEL_BIND`，并在新机器完成账号登录。确认账号与执行计划后，才启用 `workbuddy.timer`；定时器示例为北京时间07:17、12:17和23:37。原账号、令牌、面板口令、推送配置、状态与日志未包含在本目录。

## 检查

```sh
cd app
python3 -B -m unittest discover -s tests -p 'test_*.py'
```

上传时117项测试在断网命名空间内通过，未调用真实登录、签到或推送接口。源程序用法见 `app/README.md`。`run.sh` 会读取本机 `workbuddy.env` 和 `credentials.env`；示例配置默认不推送通知。上游依赖声明为 `requests>=2.25.0`，本机验证使用 requests 2.32.3。
