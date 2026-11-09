# 当前服务器版本的源码与部署

本目录保存 ClawChat 0.7.67 当前工作区的源码快照。上游为 https://github.com/Lenka0605/ClawChat ，基准提交 `7118812`。保留原有 README、开发说明、网页、库、测试，以及 macOS / Windows / Android 源文件和构建脚本。

当前服务器对 `lib/agents.js` 有一处适配：Claude 子进程环境带 `IS_SANDBOX=1`，以配合现有运行方式。本次包含该工作区改动，不导入原 Git 历史。

## 快速运行

要求 Node.js 22 或更新版本、Git，无 npm 生产依赖。在本目录执行：

```sh
node --version
npm test
npm start
```

网页默认 http://127.0.0.1:7317/ 。安装并登录需要的 AI 官方 CLI 后，ClawChat 才能调用相应成员。账号登录、macOS/Windows 安装和 Android 构建方法见原有 README。

## 数据与代码分离

运行数据默认位于启动用户的 `~/.clawchat/`，可通过 `CLAWCHAT_HOME` 指定独立目录。聊天记录、附件、头像、会话标识、API Key 不在源码快照内；重新部署需要自行配置账号。

遵守上游忽略规则，不提交从厂商应用提取的 `public/icons/`、`public/app-icon.png` 及构建产物；图标提取/构建方法沿用上游脚本。

## Linux/systemd 部署

安装 Node.js 与 Git，将本目录复制到程序路径，例如：

```sh
sudo install -d /opt/clawchat
sudo cp -a . /opt/clawchat/
```

`deploy/clawchat.service.example` 是当前服务器的服务模板，使用 `/opt/clawchat`、`/usr/local/bin/node` 和 `/root` 的 CLI 环境。安装前按实际运行用户调整 `User`、`WorkingDirectory`、`ExecStart`、`HOME`、`PATH`。可以新增 `Environment=CLAWCHAT_HOME=/你的独立数据目录`，目录应由运行用户拥有。确认配置后安装：

```sh
sudo install -m 644 deploy/clawchat.service.example /etc/systemd/system/clawchat.service
sudo systemctl daemon-reload
sudo systemctl enable --now clawchat
curl --fail http://127.0.0.1:7317/api/health
```

示例日志写入 `/var/log/clawchat.log`。若改为普通用户，需先配置日志文件写权限，或把 `StandardOutput` / `StandardError` 改为 `journal`。

## 可选反向代理

ClawChat 依赖本机/Tailscale 来源识别。Nginx 示例把来源转换成本机，代理层需承担访问控制。示例默认绑定 `127.0.0.1:8795` 并启用 Basic Auth，不复制当前服务器公开入口和其他项目路由。

安装 Nginx 及提供 `htpasswd` 的工具后，创建自己的口令（交互输入）：

```sh
sudo htpasswd -c /etc/nginx/clawchat.htpasswd clawchat
sudo install -m 644 deploy/nginx.conf.example /etc/nginx/conf.d/clawchat.conf
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

需要其他设备访问时，按网络配置监听地址、防火墙和 HTTPS，或使用上游的 Tailscale 方式。当前机器的口令文件不包含在仓库中。

## 测试与升级边界

`npm test` 运行单元测试。测试界面及 AI 回话时，用 `scripts/run-fake.sh` 的假 AI 实例和临时数据目录，详见 AGENTS.md，不向真实群发送测试消息。

这里是 `fwq` 多项目仓库的子目录快照。上游在线升级和安装脚本假设“ClawChat 是独立仓库根目录”，本快照应手动更新；不要通过应用在线升级更新整个 fwq 仓库。需要上游自动升级时，应单独克隆上游项目并管理服务器适配。

本次仅上传源码及示例配置，未重启或修改提供当前群聊的服务。

本次完整测试、独立复核及已知超时差异见 [VERIFICATION.md](VERIFICATION.md)。该测试在不同运行中结果不一致，原因未确认；不要将此源码快照理解为各平台全部验证通过的发行包。
