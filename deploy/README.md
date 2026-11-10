# 新服务器：从 GitHub 部署 ClawChat、远程浏览器和 Listing

这是在另一台 Linux 服务器上首次部署三个服务的统一入口。仓库提供源码、`ai-listing` 技能及其全部引用规范、浏览器启动脚本和服务配置；操作系统软件包、AI CLI 与账号登录在新机器上准备。不是现有服务器的磁盘或账号镜像。

若新机器上已有 AI，可把 [AGENT-HANDOFF.txt](AGENT-HANDOFF.txt) 交给它执行。没有确认目标服务器前，不在当前提供聊天的机器上执行下列安装命令。

## 1. 拉取代码

在新服务器安装 Git 后执行：

```sh
git clone https://github.com/yyzaxx/fwq.git /opt/fwq-source
cd /opt/fwq-source
git rev-parse HEAD
```

如果目录已存在，先检查本地改动，再使用 `git pull --ff-only`。不要强制覆盖已有改动。以下示例采用 root 用户及固定程序目录：

| 内容 | 源码目录 | 部署目录 / 数据目录 |
| --- | --- | --- |
| ClawChat | `clawchat/` | 程序 `/opt/clawchat/`，数据 `/root/.clawchat/` |
| Listing | `listing-studio/web/` | 程序 `/root/ClawChatProjects/listing/web/`，任务在其 `data/` |
| 专用浏览器 | `listing-studio/browser/` | `/root/ClawChatProjects/listing/browser/`，登录在其 `profile/` |
| Listing 技能 | `listing-studio/ai-listing/` | `/root/ClawChatProjects/listing/ai-listing/`，软链接 `/root/.codex/skills/ai-listing` |

上述目标目录有旧代码或运行数据时，先核实与备份；首次部署的复制命令不能替代已有系统的升级方案。源码拉取目录与运行数据分开。

## 2. 按新机器系统安装依赖

先查看 `/etc/os-release`、CPU 架构、内存、磁盘和交换空间，再使用该发行版的软件源安装以下依赖。Ubuntu、Debian、TencentOS 等系统的软件包名称和 Chromium 安装方式不同，不能直接互用安装命令。

- Node.js 22 或更高版本，以及 Git、Python 3、ImageMagick `convert`。
- Nginx、systemd、cgroup v2，以及提供 `htpasswd` 的工具。
- Chromium、Xvfb、openbox、x11vnc、websockify、noVNC 静态资源。
- 已安装并完成认证的 Codex CLI；ClawChat 的其他 AI 成员按实际需要单独安装和登录。

基础检查：

```sh
cat /etc/os-release
uname -m
free -m
df -h /
node --version
command -v node git python3 convert nginx systemctl htpasswd
command -v chromium-browser Xvfb openbox x11vnc websockify
test -r /usr/share/novnc/vnc.html
test -r /sys/fs/cgroup/cgroup.controllers
```

浏览器脚本默认使用 `chromium-browser` 和 `/usr/share/novnc`。如果新系统使用 `chromium` 或不同的 noVNC 目录，调整将要部署的 `browser/start.sh`。两个 Node 服务模板默认使用 `/usr/local/bin/node`；先与 `command -v node` 比较，再调整服务的 `ExecStart` 和 `PATH`。不要为了适配模板覆盖已有的系统程序。

Codex 安装方式见 [OpenAI 官方 CLI 文档](https://learn.chatgpt.com/docs/cli)。远程服务器可以使用设备码登录；在目标服务用户下完成，登录方式及适用条件见 [OpenAI 官方认证文档](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)：

```sh
codex login --device-auth
codex login status
```

登录链接和一次性验证码由操作者在自己的浏览器处理。不从公开仓库获取账号认证，也不提交账号缓存。安装服务时确保 systemd 的 `PATH` 包含实际 Node 和 Codex 所在目录。

## 3. 部署 ClawChat

从仓库根目录执行，先按上节校正服务模板中的 Node 与 CLI 路径。安装步骤沿用 [ClawChat 部署说明](../clawchat/DEPLOYMENT.md)：

```sh
install -d /opt/clawchat
cp -a clawchat/. /opt/clawchat/
install -m 0644 clawchat/deploy/clawchat.service.example /etc/systemd/system/clawchat.service
systemctl daemon-reload
systemctl enable --now clawchat.service
curl --fail http://127.0.0.1:7317/api/health
```

ClawChat 在本机 7317 端口运行。首次部署没有旧群聊、附件或模型账号；先在新界面配置要使用的成员。源码自带的假 AI 测试方式见 `clawchat/AGENTS.md`；不要为了验证界面向真实群聊发送测试消息。

## 4. 部署浏览器、Listing 和技能

进入 `listing-studio/`，按 [浏览器与网站联合部署说明](../listing-studio/browser/README.md) 安装。该说明包含完整的复制、技能软链接、两个服务及资源 drop-in 安装命令：

```sh
cd /opt/fwq-source/listing-studio
```

必须同时安装 `listing.slice`、`listing-browser.service`、`listing-web.service` 及两个资源 drop-in，再启动服务。Listing 的物理内存硬上限为 1GiB、交换空间上限 512MiB，软回收阈值 832MiB、CPU 配额一个核心；浏览器最多 2 个业务标签页，任务串行执行。新机器容量不合适时，应先评估资源，不能取消保护或通过反复重启绕过暂停。

技能入口必须存在且其相对引用文件齐全：

```sh
test -r /root/.codex/skills/ai-listing/SKILL.md
test -r /root/.codex/skills/ai-listing/references/browser.md
test -r /root/.codex/skills/ai-listing/references/research.md
test -r /root/.codex/skills/ai-listing/references/sif-browser.md
test -r /root/.codex/skills/ai-listing/references/titles.md
```

浏览器控制接口是本机 `9223`，noVNC 后端是本机 `6081`，Listing 是本机 `7350`。它们属于同一服务器；用户通过 noVNC 操作的浏览器，就是 Listing 执行器通过 CDP 操作的浏览器。

## 5. 配置网页入口

ClawChat 的反代模板是 `clawchat/deploy/nginx.conf.example`；Listing 与远程浏览器的模板是 `listing-studio/ops/nginx-server.conf.example`。按各自说明生成新机器配置，不能复制旧服务器的私人应用路径或登录资料。

ClawChat 模板默认仅本机监听并使用独立访问口令。先通过 `htpasswd` 在新机器设置口令，再加载它。Listing 模板默认监听 8796；首次核验可将生成配置中的 `listen 8796;` 改成 `listen 127.0.0.1:8796;`，通过 SSH 隧道访问。确定公网 IP / 域名和访问方式后，再配置相应监听、防火墙和访问控制。

使用隧道时，在操作者自己的电脑执行：

```sh
ssh -N -L 8795:127.0.0.1:8795 -L 8796:127.0.0.1:8796 用户名@新服务器
```

随后本机浏览器可打开：

- ClawChat：`http://127.0.0.1:8795/`。
- Listing：`http://127.0.0.1:8796/`。
- 远程浏览器：`http://127.0.0.1:8796/listing-browser/vnc.html?autoconnect=1&resize=scale&path=listing-browser%2Fwebsockify`。

通过远程浏览器登录 Amazon / Sif；验证码由账号持有人完成。新机器不依赖旧机器的 Cookie。登录后，Listing 页面应显示浏览器已连接、任务服务可用。

## 6. 验收并交付

```sh
systemctl is-active clawchat.service listing-browser.service listing-web.service nginx
curl --fail http://127.0.0.1:7317/api/health
curl --fail http://127.0.0.1:9223/json/version
curl --fail -o /dev/null http://127.0.0.1:6081/vnc.html
curl --fail -o /dev/null http://127.0.0.1:8796/
curl --fail -o /dev/null http://127.0.0.1:8796/listing-browser/vnc.html
systemctl show listing.slice -p MemoryHigh -p MemoryMax -p MemorySwapMax -p CPUQuotaPerSecUSec -p TasksMax
```

还要实际打开 noVNC，确认 WebSocket 连接后可看到并操作桌面；仅 `vnc.html` 返回 200 不算连接成功。检查 Codex 认证状态、技能文件、Amazon/Sif 登录，以及手机页面布局。账号登录未完成时，应明确交付为“服务已启动，等待登录”，不能称为真实调研可用。

最终记录新服务器地址、系统版本、源码提交号、三个访问入口、服务状态与尚待用户完成的登录。这里提供的流程在原服务器核对过源码、配置和连接；没有取得另一台服务器的连接信息前，不代表已在那台机器部署或验证。

## 后续从 GitHub 更新

源码目录使用 `git pull --ff-only` 获取后续提交。更新前确认 Listing 没有运行或等待登录的任务，并检查 ClawChat 是否有人正在工作；按改动范围更新对应程序和服务。保留 `/root/.clawchat/`、Listing `data/`、浏览器 `profile/`、`.runtime.json` 和新机器的认证配置。不要对运行数据执行 `git clean` 或整目录删除。

`clawchat/` 是多项目仓库中的快照，不使用它的上游应用内在线升级去替换整个 `fwq` 仓库。详细边界沿用 `clawchat/DEPLOYMENT.md`。
