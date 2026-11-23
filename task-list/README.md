# 任务清单

网页支持新建、修改、完成和筛选任务。服务在服务器的 `data/tasks.json` 保存清单，打开同一入口的设备共享一份数据。通过环境变量 `DATA_FILE` 可另设文件路径。

使用 Node.js 22 或更新版本。在此目录运行 `npm test` 和 `npm start`。服务默认监听 `127.0.0.1:7380`，无需安装第三方 npm 包。

将目录部署到 `/root/ClawChatProjects/task-list`，创建 `data/`，再安装 [systemd 模板](ops/task-list.service.example)。在其他目录部署时调整模板内的程序和数据路径。

可使用 [site-access](../site-access/README.md) 的 8799 入口，或在 HTTPS 站点下使用 `/tasks/`。将 [来源校验](ops/tasks-origin.conf.example) 放入 Nginx 的 `http` 上下文，替换示例域名，保留实际外部端口，再在对应的 HTTPS `server` 中包含 [路由模板](ops/tasks-location.inc.example)。免登录入口允许来访者查看和编辑清单，跨站请求受来源校验限制。

任务数据不随源码分发。
