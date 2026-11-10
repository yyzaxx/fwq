# BiliLottery Web 服务器源码

这里包含当前部署的网页、Node.js 后端、共享桌面版源码、LotteryAutoScript 2.11.3 引擎、认证反代和定时启动脚本。保留应用及引擎的 GPL-3.0-or-later 许可证。已收录不可见旧转发跳过清理、分组失败不阻断后续互动等服务器修复，来源见 `app/SOURCE-INFO.json`。

`app/` 是现有 Linux 部署的源码快照，不是完整 Windows 安装包；原说明中提及的 Windows 启动器未在当前部署目录中。使用 Node Web 模式不需要安装 Electron。

## 新机器安装

需要 Node.js 22+、npm 和 Python 3。以 fwq 仓库根目录为起点：

```sh
install -d /opt/bililottery
cp -a bililottery/. /opt/bililottery/
npm --prefix /opt/bililottery/app/engine/LotteryAutoScript ci --omit=dev
id bili >/dev/null 2>&1 || useradd --system --home-dir /opt/bililottery --shell /sbin/nologin bili
install -d -m 0700 /opt/bililottery/app/web-data
umask 077
test -s /opt/bililottery/proxy.password || python3 -c 'import secrets; print(secrets.token_urlsafe(24))' > /opt/bililottery/proxy.password
chown -R bili:bili /opt/bililottery
install -m 0644 bililottery/deploy/bili-web.service.example /etc/systemd/system/bili-web.service
install -m 0644 bililottery/deploy/bili-auth.service.example /etc/systemd/system/bili-auth.service
systemctl daemon-reload
systemctl enable --now bili-web.service bili-auth.service
```

先按 `command -v node` 调整两个服务模板的 Node 路径。网页后端只监听本机8787，认证反代使用8790，以 `bili` 用户和本机生成的 `proxy.password` 验证。反代需要改写上游 Host 并移除 Origin，`auth-proxy.cjs` 已实现。

首次在新机器填写账号 UID 并扫码登录，默认没有 Cookie，保持模拟模式验证配置后再由操作者选择执行方式。定时启动的 `.service.example`、`.timer.example` 和 `autostart.sh` 已附带，但不会因下载源码而启用。当前服务器的 Cookie、账号设置、去重台账、二维码、日志和代理口令没有上传。

## 离线检查

```sh
cd app
node --test test/*.test.cjs
```

6项服务器修复回归在断网命名空间通过，使用模拟接口，没有执行真实关注、转发或删帖。`bili-8790/` 继续保留原来的修复补丁和说明；本目录补齐已部署的完整 Web 程序及引擎源码。
