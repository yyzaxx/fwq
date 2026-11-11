# 系统运行组件

业务代码分别位于 `clawchat/`、`listing-studio/`、`qingdan/`、`workbuddy/`、`bililottery/`、`lottery/` 和 `octop/`。本目录记录本机使用的基础运行软件版本，配合各业务目录的部署模板在新服务器安装。

Nginx、Docker/containerd、SSH、防火墙、系统日志与定时任务属于操作系统软件包，不把系统二进制、Docker 存储目录或整套 `/etc` 复制进源码仓库。版本快照见 `software-versions.json`；新机器按其发行版和架构安装相应软件，再校正服务模板中的程序路径。

- Node.js、Python、Codex 等 AI 执行器与 Chromium/noVNC：按各业务部署说明安装，保留版本信息；不复制账号缓存、供应商执行器二进制或整个依赖环境。
- Nginx：ClawChat、Listing/浏览器和轻单的模板在各自部署目录；私人应用路径、口令文件与服务器私有网络配置不在仓库内。
- Docker/containerd：按目标系统安装。已移除的 Pansou 容器、镜像和缓存不在本仓库，也不因部署其他业务而恢复。
- SSH、firewalld、cron/systemd timers：由目标系统提供，业务的定时器示例随所属项目保存。
- 腾讯云监控、安全和远程执行代理：由云服务器环境提供，不复制厂商二进制或本机身份凭据到公开仓库。

当前机器的业务源码、基础软件版本和部署配置属于不同层次。账号认证、业务运行数据和服务验收应在新机器分别完成；下载源码不等于已完成全部软件安装或账号迁移。

## 当前运行配置

[optimization/](optimization/README.md) 收录小内存服务器上的 ClawChat、Octop 资源预算、后台任务调度、zswap 压缩交换缓存和 Docker 按需启动设置。说明包含容量条件、应用命令、核验和恢复方式。

[1Panel 部署目录](../1panel/README.md) 提供 v2.4.2 社区版官方安装包地址、SHA-256、独立资源组以及首次登录和 HTTPS 配置步骤。
