# 1Panel 社区版部署

本目录保存 1Panel 社区版 v2.4.2 的官方安装包校验信息，以及本服务器使用的 systemd 资源配置。源码和发行包由 [1Panel 官方项目](https://github.com/1Panel-dev/1Panel) 发布，许可证为 GPL-3.0。安装流程见 [官方文档](https://1panel-dev.github.io/docs/v2/installation/online_installation/)。

2026-11-11 已在 TencentOS Server 4、x86_64、约 2GB 内存的原服务器完成安装，核实中文登录、HTTPS、系统概览和 Docker 容器读取。新机器部署时先检查系统、架构、内存和占用端口，按实际负载调整资源预算。

## 准备资源配置

先在仓库根目录执行。首次安装前放置配置，可以让面板的首次启动就进入资源组。

```sh
install -D -m 0644 1panel/deploy/onepanel.slice /etc/systemd/system/onepanel.slice
install -D -m 0644 1panel/deploy/1panel-core.service.d/20-resources.conf /etc/systemd/system/1panel-core.service.d/20-resources.conf
install -D -m 0644 1panel/deploy/1panel-agent.service.d/20-resources.conf /etc/systemd/system/1panel-agent.service.d/20-resources.conf
systemctl daemon-reload
```

`onepanel.slice` 为核心和本机 agent 合计设置 384MiB 软回收阈值、512MiB 内存上限、128MiB 交换空间上限、一个 CPU 核心配额。容器应用有各自的 Docker 资源配置，需要单独预算。

已有 1Panel 安装时先核对现有配置和数据，再按官方升级流程处理。以下安装命令用于首次部署。

## 安装已校验版本

需要 root 权限、可用的互联网连接、curl 和 tar。安装脚本支持基于 Debian 或 RedHat 的主流 Linux 发行版。其他架构应从官方获取对应安装包及校验值。

```sh
install -d -m 0700 /root/1panel-install
cd /root/1panel-install
curl --fail --location --retry 2 \
  https://resource.fit2cloud.com/1panel/package/v2/stable/v2.4.2/release/1panel-v2.4.2-linux-amd64.tar.gz \
  -o 1panel-v2.4.2-linux-amd64.tar.gz
printf '%s  %s\n' \
  5e2bbe6e88c1fe019ee33c9b8e63abd64ca73906c7101faf1e2be9b14449ad03 \
  1panel-v2.4.2-linux-amd64.tar.gz | sha256sum --check
```

确认校验成功后解压并安装。

```sh
tar -xzf 1panel-v2.4.2-linux-amd64.tar.gz
cd 1panel-v2.4.2-linux-amd64
printf '%s\n' cn > .selected_edition
bash ./install.sh
```

按提示选择本机安装目录、可用端口、安全入口、用户名和密码。原服务器使用的面板端口为 10086，新机器可自行选择。已有 Docker 时使用现有安装，镜像加速配置按新机器网络情况选择。

通过官方工具查看服务状态及入口。

```sh
1pctl status
1pctl user-info
systemctl is-enabled 1panel-core.service 1panel-agent.service
systemctl show onepanel.slice -p MemoryHigh -p MemoryMax -p MemorySwapMax -p CPUQuotaPerSecUSec
```

## HTTPS 和首次登录

新服务器由所有者设置自己的账号、密码和安全入口。可先通过 SSH 隧道进入初始配置页面，以下示例采用 10086 端口。

```sh
ssh -N -L 10086:127.0.0.1:10086 用户名@新服务器
```

在本机浏览器打开 `http://127.0.0.1:10086/新机器的安全入口`。勾选软件许可协议后登录，在“面板设置”中配置面板 SSL，填写实际访问的 IP 或域名，启用 HTTPS。

1Panel 生成的自签证书会触发浏览器的签发机构信任提示。需要消除提示时，在面板中配置受浏览器信任的机构签发的证书。证书与私钥在新机器生成或导入。

使用 `https://新服务器地址:面板端口/安全入口` 登录，实际操作中文页面，确认系统概览、容器列表和设置页面可用。公网访问还需在系统防火墙及云安全组中放行选择的面板端口。

## 运行目录和更新

默认程序为 `/usr/local/bin/1panel-core`、`/usr/local/bin/1panel-agent` 和 `/usr/local/bin/1pctl`，运行数据在 `/opt/1panel/`。账号、数据库、密钥、证书、会话和安装日志由目标机器保管。

后续更新使用面板内的升级功能或对应版本的官方流程，并保留 systemd 资源配置。`release.json` 记录本次实际校验的安装包版本与 SHA-256。
