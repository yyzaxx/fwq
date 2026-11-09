# Bili 抽奖助手修复补丁

适用部署：BiliLotteryDesktop Web 外壳及 LotteryAutoScript v2.11.3 引擎。上游引擎：https://github.com/shanmiteko/AutoScript ，遵循其 GPL-3.0-or-later 许可。

- `cleanup.patch`：外壳 src/cleanup.cjs 核对旧转发时，接口返回 4101152（动态不可见）则跳过删除并保留清理记录；其他错误继续停止。
- `monitor.patch`：引擎 lib/core/monitor.js 的分组失败不阻断点赞转发；遗留 3001 保留错误状态，不写入去重历史。
- 两个 test.cjs 使用临时目录和替代网络依赖，不执行真实账号互动；目前测试目标为既有部署的 /opt/bililottery/app 路径，可按部署位置调整。

补丁以实际部署文件为基准，应用前先检查上下文并备份。外壳 cleanup.patch 应用于 src/cleanup.cjs；monitor.patch 应用于引擎 lib/core/monitor.js。上下文中路径仅用于定位原文件。

```sh
node --test cleanup.test.cjs monitor.test.cjs
```

不会随此仓库提供任何账号凭据、私密配置、去重历史或转发台账。对历史部分成功任务，应逐项核实后仅补缺失步骤，禁止盲目重跑或清空历史。
