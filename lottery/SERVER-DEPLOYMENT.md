# 原独立 LotteryAutoScript 部署快照

本目录保留 `/opt/lottery/src` 的 LotteryAutoScript v2.11.3 源码、依赖锁和原部署包装。它与 `bililottery/app/engine/LotteryAutoScript` 是两个独立运行目录，源文件保留各自现状，不合并覆盖。上游为 [shanmiteko/LotteryAutoScript](https://github.com/shanmiteko/LotteryAutoScript)，许可证见 `LICENSE`。

不包含现有 `env.js`、`my_config.js`、Cookie 设置脚本、参与台账、日志、依赖目录及历史带令牌的日志查看器配置。复制源码后，新机器使用 `env.example.js` 和 `my_config.example.js` 创建自己的配置。

```sh
install -d /opt/lottery/src
cp -a lottery/. /opt/lottery/src/
cd /opt/lottery/src
npm ci --omit=dev
```

先阅读上游 `README.md` 并在新机器配置账号。`deploy/run.sh` 支持原程序的 start/check/clear/login 等动作；当前服务器的定时中奖检查模板为 `deploy/lottery-check.service.example` 与 `deploy/lottery-check.timer.example`。根据自己使用的程序目录校正 Node 路径与日志目录，再安装所需服务，不默认同时为同一账号启用 Web 版和独立版的自动参与流程。

`test/index.js` 中包含上游在线测试，不作为上传前的自动测试运行。上传前仅检查脚本语法和可隔离的离线测试，不使用真实账号执行动作。
