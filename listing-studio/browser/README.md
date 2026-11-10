# 远程浏览器与网站一起部署

网站通过 Chromium 的 CDP 接口执行 Amazon / Sif 操作；用户通过 noVNC 接管同一个浏览器，处理登录或验证码。这两条连接使用同一份 `browser/profile/`，随后网站继续原任务。浏览器不是网站内嵌的独立浏览器组件，需要以下系统依赖和服务一起运行。

| 连接 | 本机地址 | 用途 |
| --- | --- | --- |
| Listing 网站 | `127.0.0.1:7350` | 页面、任务 API、执行器 |
| Chromium CDP | `127.0.0.1:9223` | 执行器操作浏览器；页面限额、任务收尾与资源回收 |
| x11vnc | `127.0.0.1:5901` | 导出 Xvfb `:101` 的桌面 |
| noVNC / websockify | `127.0.0.1:6081` | 将浏览器里的桌面操作转发到 VNC |
| Nginx `/listing-browser/` | 与网站同一入口 | noVNC 页面及 WebSocket 反代 |

## 系统依赖

先按 Linux 发行版安装这些程序，再确认以下检查均成功。仓库提供启动脚本和配置，不包含这些第三方程序的二进制或浏览器登录资料。

```sh
command -v chromium-browser Xvfb openbox x11vnc websockify
test -r /usr/share/novnc/vnc.html
command -v node python3 convert nginx systemctl
node --version
codex login status
```

`start.sh` 默认使用命令 `chromium-browser` 和 noVNC 静态目录 `/usr/share/novnc`。其他发行版若使用 `chromium` 命令或不同静态目录，先修改对应路径。需要 Node.js 22 或更高版本、systemd 和 cgroup v2；真实调研还需要网站 README 中列出的 `ai-listing` 技能及引用文件。Codex 认证需在服务运行用户下单独完成。

## 首次部署服务

以下命令在 `listing-studio/` 目录以 root 执行，使用示例中的固定部署目录 `/root/ClawChatProjects/listing/`。其他用户或目录部署时，需要同时修改网站服务、浏览器服务、启动脚本及执行器技能路径。

```sh
install -d -m 0755 /root/ClawChatProjects/listing
cp -a web browser /root/ClawChatProjects/listing/
install -d -m 0700 /root/ClawChatProjects/listing/browser/profile
chmod 0755 /root/ClawChatProjects/listing/browser/start.sh

install -m 0644 ops/listing-browser.service /etc/systemd/system/listing-browser.service
install -m 0644 web/ops/listing-web.service /etc/systemd/system/listing-web.service
install -m 0644 web/ops/listing.slice /etc/systemd/system/listing.slice
install -D -m 0644 web/ops/listing-browser.service.d/20-resources.conf /etc/systemd/system/listing-browser.service.d/20-resources.conf
install -D -m 0644 web/ops/listing-web.service.d/20-resources.conf /etc/systemd/system/listing-web.service.d/20-resources.conf

systemd-analyze verify /etc/systemd/system/listing.slice /etc/systemd/system/listing-browser.service /etc/systemd/system/listing-web.service
systemctl daemon-reload
systemctl enable --now listing-browser.service
systemctl enable --now listing-web.service
```

网站与浏览器必须共同进入 `listing.slice`，共享 1GiB 内存、512MiB 交换空间和一个 CPU 核心的硬预算。网站会每秒检查标签页，上限为 2 个；任务串行执行，收尾后按占用回收浏览器进程，磁盘 profile 保留。两个服务的资源 drop-in 都需安装，网站在资源保护未生效时会拒绝开始生产任务。

## 配置同源 Nginx 入口

`ops/nginx-server.conf.example` 提供独立的 8796 端口入口，同时转发网站、noVNC 静态页面和 WebSocket。下面从新部署机器自身生成的 `.runtime.json` 读取应用路径，生成本机配置；仓库没有包含原服务器的私人路径。

先等待网站服务成功启动并生成 `/root/ClawChatProjects/listing/web/.runtime.json`。仍在 `listing-studio/` 目录执行：

```sh
python3 - <<'PY'
import json, pathlib, re
runtime = pathlib.Path('/root/ClawChatProjects/listing/web/.runtime.json')
base_path = json.loads(runtime.read_text())['basePath']
if not re.fullmatch(r'/[A-Za-z0-9/_-]+/', base_path):
    raise SystemExit('应用路径格式异常，请核实网站配置')
template = pathlib.Path('ops/nginx-server.conf.example').read_text()
pathlib.Path('ops/nginx-server.conf').write_text(template.replace('__LISTING_BASE_PATH__', base_path))
PY
install -m 0600 ops/nginx-server.conf /etc/nginx/conf.d/listing-studio.conf
nginx -t
systemctl reload nginx
```

如果另外设置了 `APP_BASE_PATH`，应将模板占位符替换为该环境变量的实际值。生成的 `ops/nginx-server.conf` 已被 Git 忽略。复用已有 Nginx `server` 时，可使用 `web/ops/nginx-location.conf` 的两个 location；网站从 `/listing-app/` 下的本机私人路径进入，无需独占 8796 端口。noVNC 与网站需要同源，以匹配页面中的 `/listing-browser/` 链接和 WebSocket 路径。

## 连接与检查

独立入口部署后，网站为 `http://服务器地址:8796/`。远程浏览器入口为：

```text
http://服务器地址:8796/listing-browser/vnc.html?autoconnect=1&resize=scale&path=listing-browser%2Fwebsockify
```

```sh
systemctl is-active listing-web.service listing-browser.service
curl --fail http://127.0.0.1:9223/json/version
curl --fail -o /dev/null http://127.0.0.1:6081/vnc.html
curl --fail -o /dev/null http://127.0.0.1:8796/listing-browser/vnc.html
systemctl show listing.slice -p MemoryMax -p MemorySwapMax -p CPUQuotaPerSecUSec
```

通过 noVNC 在专用浏览器内登录 Amazon / Sif，再从网站提交任务。若任务等待登录，先在该浏览器完成验证，再点击网站中的继续按钮。仅 HTML 返回 200 不代表 WebSocket 或账号登录已就绪，应实际打开 noVNC 确认能看到并操作桌面。

`browser/profile/` 保存 Cookie 和登录信息，已从版本库排除；新机器需要重新登录。网站任务、报告和模板库保存在另行忽略的 `web/data/`，迁移时按私有运行数据处理。

## 故障定位

- 网站显示浏览器未连接：先检查 `listing-browser.service` 和本机 `9223/json/version`。
- noVNC 页面打开但无法连接：检查 `/listing-browser/websockify` 的 WebSocket 反代、websockify 和 x11vnc。
- 浏览器服务启动失败：查看 `journalctl -u listing-browser.service -n 50`，以及部署目录 `browser/` 下的日志，核实程序路径、noVNC 静态目录及 `:101` 是否占用。
- 资源保护暂停：在网站检查原因并恢复任务；批量恢复仍经过资源检查，不通过反复重启绕过硬上限。
