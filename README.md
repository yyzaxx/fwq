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
