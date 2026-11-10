# 服务器项目代码

## 轻单

`qingdan/` 是所有设备共用的任务清单，包含网页、Node.js/SQLite 后端、自动化测试和 Nginx/systemd 部署配置。

```sh
cd qingdan
npm test
DB_PATH=/tmp/qingdan.sqlite PORT=8767 node server.js
```

需要 Node.js 24，无生产 npm 依赖。详细说明见 `qingdan/README.md`。

## 8790 抽奖助手修复补丁

`bili-8790/` 保存旧转发不可见时跳过清理、分组失败不阻断后续互动及对应回归测试。完整引擎仍属于上游项目，原部署使用 LotteryAutoScript v2.11.3（GPL-3.0-or-later）。本目录仅包含修复补丁和隔离测试，见其说明。

此仓库不包含服务器密码、账号 Cookie、私钥、运行数据库、动态台账、备份或日志。部署时使用各服务器自身配置。

## ClawChat

`clawchat/` 是当前群聊网站 ClawChat 0.7.67 的源码快照，包含现有服务器适配、前后端、测试和各平台构建文件。Linux 部署、数据目录及多项目仓库下的升级边界见 `clawchat/DEPLOYMENT.md`。聊天记录、上传附件、账号密钥及运行数据不包含在内。

## Listing Studio

`listing-studio/` 是商品图片调研与英文标题工作台，包含网站源码、100项自动测试、专用浏览器启动脚本及 Nginx/systemd 资源保护配置。支持图片与 ZIP 批量调研、两套模板、报告下载、历史删除、任务重新开始、一键恢复暂停任务和最多2个浏览器标签页。运行依赖与部署步骤见 [Listing Studio 说明](listing-studio/README.md)。

任务记录、商品图片、报告、模板库、Cookie、浏览器 profile、账号凭据与私人访问路径不包含在内。

## 新服务器联合部署

从 GitHub 拉取并部署 ClawChat、远程浏览器和 Listing，统一入口见 [deploy/README.md](deploy/README.md)。其中包含目录、依赖、技能安装、服务与反代顺序、账号登录和实际验收要求；[deploy/AGENT-HANDOFF.txt](deploy/AGENT-HANDOFF.txt) 可直接交给新服务器上的 AI 执行。
