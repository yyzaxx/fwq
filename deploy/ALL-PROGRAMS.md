# 全部业务程序目录与部署入口

本仓库保存当前服务器的业务源码和部署参考，私人配置与运行数据分开管理。

| 程序 | 仓库位置 | 部署入口 |
| --- | --- | --- |
| ClawChat | `clawchat/` | `clawchat/DEPLOYMENT.md` |
| Listing 网站与专用浏览器 | `listing-studio/` | `listing-studio/browser/README.md` |
| 轻单 | `qingdan/` | `qingdan/README.md` |
| WorkBuddy Daily 和控制台 | `workbuddy/` | `workbuddy/README.md` |
| B站抽奖 Web、认证代理、内置引擎 | `bililottery/` | `bililottery/README.md` |
| 原独立抽奖/中奖检查程序 | `lottery/` | `lottery/SERVER-DEPLOYMENT.md` |
| Octop 与配套组件 | `octop/` | `octop/README.md` |
| Nginx、Docker 等系统软件 | `server-runtime/` | `server-runtime/README.md` |

ClawChat、Listing 和轻单的现有运行源码已与仓库核对；差异为发布说明、部署模板或忽略规则，未发现遗漏的线上业务代码修改。`bili-8790/` 保留早期修复补丁，`bililottery/` 现已补齐完整部署源码。Octop 收录安装版 Python 源码、内置资源与已构建网页，完整上游开发工作区另见其官方仓库。

## 新服务器使用

```sh
git clone https://github.com/yyzaxx/fwq.git /opt/fwq-source
cd /opt/fwq-source
```

已有代码时先核实本地修改，再 `git pull --ff-only`。先按 [三个核心服务的联合部署说明](README.md) 部署 ClawChat、Listing 和远程浏览器；其余程序按上表选择需要的部分安装，不因仓库存在定时器示例而自动启用全部任务。各程序保留自身许可证和上游署名。

账号登录、Cookie、Token、控制台口令、个人记忆、数据库、参与台账、日志、模型权重和浏览器 profile 不通过这个公开仓库迁移。配置示例不包含真实账号。已移除的 Pansou 不在部署清单，也不会被恢复。

这些文件已完成源码整理、配置检查及适用的离线测试；不代表已在另一台服务器安装。新机器仍需安装系统依赖、校正可执行路径、核对整体资源预算、完成所需账号登录，再逐项检查服务与网页入口。
