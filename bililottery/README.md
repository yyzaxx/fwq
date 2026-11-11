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

测试覆盖原有服务器修复、手动动态清理、中奖通知统计及 Web 接口与确认流程，使用模拟账号和接口，不执行真实关注、转发或删帖。`bili-8790/` 继续保留原来的修复补丁和说明；本目录补齐已部署的完整 Web 程序及引擎源码。

## 动态清理与中奖统计

Web 主页新增“一键删除动态”。默认读取当前账号的全部转发并保留原创，也可选择“本工具记录的抽奖转发”或“全部动态（含原创）”。先读取清单并确认范围、账号和数量，再确认删除；仅处理本次清单，可以中途停止，已删除内容无法撤销。手动清理不等待开奖24小时，因此也可能包含尚未开奖的转发。保留ID列表仍生效；无法识别原动态的转发在存在保留ID时会跳过。模拟模式只演练，不删帖。

主页显示“最近七天中奖次数为”，按滚动168小时内的站内系统通知、回复、@和私信中明确的中奖消息去重统计，包含已读消息，不修改消息已读状态。它依赖账号能读取到的通知，不能证明所有活动的实际中奖总数。登录后空闲时自动更新，也可点击“更新统计”；其他操作优先于后台统计。扫描未完成时显示未知或上次完整结果，不把接口失败算成0次。缓存只保存去重标识与时间，不保存私信正文；账号凭据与缓存均留在本机 `web-data/runtime/`，不应提交到仓库。
