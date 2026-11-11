# 小内存服务器运行配置

这些配置来自 2026-11-10 在 TencentOS Server 4、Linux 6.6、约 2GB 内存机器上实施的在线优化。适用于本仓库约定的服务名称，应用前根据目标机器的容量和任务高峰调整预算。

## 服务预算

| 服务 | 内存软阈值 | 内存上限 | 交换空间上限 | 调度设置 |
| --- | --- | --- | --- | --- |
| ClawChat | 896MiB | 1280MiB | 512MiB | CPUWeight 200，IOWeight 200 |
| Octop | 512MiB | 768MiB | 384MiB | CPUWeight 50，IOWeight 20 |
| WorkBuddy、独立抽奖、中奖检查、定时抽奖启动 | 沿用服务配置 | 沿用服务配置 | 沿用服务配置 | Nice 10，CPUWeight 25，IOWeight 20 |

ClawChat 另有 128MiB 的 MemoryLow 回收保护值。各服务的上限分别生效，整机仍需按同时运行的任务预算总量。1Panel 的资源组见 [1Panel 部署](../../1panel/README.md)。Listing 的预算见 [Listing 资源配置](../../listing-studio/web/ops/listing.slice)。

在仓库根目录按实际需要选择配置。每条命令会覆盖对应 drop-in，先备份目标机器的同名文件。

```sh
install -D -m 0644 server-runtime/optimization/systemd/clawchat.service.d/50-memory-budget.conf /etc/systemd/system/clawchat.service.d/50-memory-budget.conf
install -D -m 0644 server-runtime/optimization/systemd/octop.service.d/50-memory-budget.conf /etc/systemd/system/octop.service.d/50-memory-budget.conf
```

已部署对应后台服务时，选择所需定时任务的调度配置。

```sh
install -D -m 0644 server-runtime/optimization/systemd/workbuddy.service.d/50-background-priority.conf /etc/systemd/system/workbuddy.service.d/50-background-priority.conf
install -D -m 0644 server-runtime/optimization/systemd/lottery.service.d/50-background-priority.conf /etc/systemd/system/lottery.service.d/50-background-priority.conf
install -D -m 0644 server-runtime/optimization/systemd/lottery-check.service.d/50-background-priority.conf /etc/systemd/system/lottery-check.service.d/50-background-priority.conf
install -D -m 0644 server-runtime/optimization/systemd/bili-autostart.service.d/50-background-priority.conf /etc/systemd/system/bili-autostart.service.d/50-background-priority.conf
systemctl daemon-reload
```

ClawChat 和 Octop 的资源参数可以在线应用。写入前先检查当前占用，确保新上限高于实际工作集。

```sh
systemctl show clawchat.service octop.service -p MemoryCurrent -p MemorySwapCurrent
systemctl set-property --runtime clawchat.service MemoryLow=128M MemoryHigh=896M MemoryMax=1280M MemorySwapMax=512M CPUWeight=200 IOWeight=200
systemctl set-property --runtime octop.service MemoryHigh=512M MemoryMax=768M MemorySwapMax=384M CPUWeight=50 IOWeight=20
```

持久化 drop-in 在后续服务启动时继续生效。Nice 调整随后台任务的下一次启动生效。

## 有上限的压缩交换缓存

zswap 使用 CPU 压缩即将交换出去的内存页，在 RAM 中按需保存压缩缓存。配置使用 LZ4、zsmalloc，最大池容量为物理内存的 10%。已有磁盘交换空间承担后备存储。[Linux 6.6 官方说明](https://docs.kernel.org/6.6/admin-guide/mm/zswap.html)

先检查目标内核提供所需参数和算法。

```sh
test -r /sys/module/zswap/parameters/enabled
test -w /sys/module/zswap/parameters/compressor
test -w /sys/module/zswap/parameters/zpool
cat /sys/module/zswap/parameters/enabled
cat /proc/swaps
```

确认 LZ4、zsmalloc 可用后，从仓库根目录安装并应用配置。

```sh
install -D -m 0644 server-runtime/optimization/tmpfiles.d/60-server-zswap.conf /etc/tmpfiles.d/60-server-zswap.conf
systemd-tmpfiles --create /etc/tmpfiles.d/60-server-zswap.conf
cat /sys/module/zswap/parameters/enabled
cat /sys/module/zswap/parameters/compressor
cat /sys/module/zswap/parameters/zpool
cat /sys/module/zswap/parameters/max_pool_percent
```

原服务器完成过 32MiB 数据的换出、压缩、读回及校验测试。压缩效果和实际任务性能取决于数据与负载。

## Docker 按需启动

Docker 的 socket 可在客户端发起请求时启动守护进程。原服务器的 Docker unit 包含 `Requires=docker.socket` 和 `Wants=containerd.service`，已验证按需唤起成功。

先检查现有容器、依赖和 unit 定义。

```sh
docker ps -a
systemctl cat docker.service docker.socket
systemctl list-dependencies --reverse containerd.service
```

确认没有需要持续运行的容器，且 unit 支持 socket 激活后执行。

```sh
systemctl enable docker.socket
systemctl disable docker.service
systemctl stop docker.service containerd.service
```

1Panel 的容器管理等功能会访问 Docker，并触发它启动。唤起后的守护进程会保持运行，可以在确认空闲后按上面的命令停止。

## 核验和恢复

检查相关业务入口、任务队列、内存事件与交换活动。

```sh
free -m
vmstat 1 5
systemctl show clawchat.service octop.service listing.slice -p MemoryCurrent -p MemorySwapCurrent -p MemoryMax
journalctl -k --since '-30 minutes'
```

需要恢复时，按部署前备份恢复 drop-in，并恢复在线设置的资源值。移除配置文件后执行 `systemctl daemon-reload`。zswap 可通过写入 `N` 停止接收新交换页，已有压缩页会在后续访问时正常读回，相关行为见上方内核文档。

恢复 Docker 原先的开机常驻方式时，使用 `systemctl enable --now docker.service`，并按目标机器原先的状态处理 `docker.socket`。
