# 轻单：所有设备共用的任务清单

入口：http://43.172.69.232:8897/ 。所有访问者共用同一份数据，无账号隔离。

## 本地运行与测试

要求 Node.js 24（内置 node:sqlite），生产服务与后端单元测试不需要安装 npm 依赖。

```sh
npm test
DB_PATH=/tmp/qingdan-local.sqlite PORT=8767 node server.js
```

Node 服务默认仅监听本机。需要公开访问时按后面的 Nginx 步骤部署。

浏览器回归需要另外安装 Playwright 和 Chromium：

```sh
npm install --no-save --package-lock=false playwright
npx playwright install --with-deps chromium
npm run test:browser
```

安装浏览器系统依赖可能需要管理员权限。已有兼容的 Chromium 时，可设置 `CHROMIUM_PATH=/完整路径/chromium` 使用它。测试连接随机本地端口和临时数据库，自动创建 `qingdan/test-results/` 保存结果，该目录不会提交 Git。

`qa/live-smoke.cjs` 是可选的已部署环境测试，会创建并按 ID 清理专用测试任务。必须显式设置目标，不会默认访问原服务器：

```sh
QINGDAN_BASE_URL=http://你的服务器:8897 node qa/live-smoke.cjs
```

只有确实需要测试本机服务重启时，才额外设置 `QINGDAN_RESTART_SERVICE=yes`；此时脚本会执行 `systemctl restart qingdan`，需要相应权限。线上不要运行旧版批量清空脚本。

## 首次部署（Linux/systemd + Nginx）

先安装 Node.js 24 和 Nginx。确认 `node --version` 是 v24 或更新版本，并确保可使用 `sudo`。以下从本目录执行。

先复制程序和网页，保留数据库目录与程序目录分离：

```sh
sudo install -d -m 755 /opt/qingdan/dist /usr/share/nginx/qingdan
sudo install -m 644 server.js package.json /opt/qingdan/
sudo install -m 644 dist/index.html dist/app.js dist/tasks.js dist/style.css /opt/qingdan/dist/
sudo install -m 644 dist/index.html dist/app.js dist/tasks.js dist/style.css /usr/share/nginx/qingdan/
```

确认服务文件中 Node 的路径存在。模板使用 `/usr/local/bin/node`；若 `command -v node` 返回其他路径，先修改 `deploy/qingdan.service` 的 `ExecStart`，动态服务用户必须能访问该可执行文件，不要使用仅 root 可访问的家目录安装路径。

安装并启动后端，再安装 Nginx 配置：

```sh
sudo install -m 644 deploy/qingdan.service /etc/systemd/system/qingdan.service
sudo systemctl daemon-reload
sudo systemctl enable --now qingdan
curl --fail http://127.0.0.1:8767/api/health
sudo install -m 644 deploy/qingdan.conf /etc/nginx/conf.d/qingdan.conf
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
curl --fail http://127.0.0.1:8897/api/health
```

后端健康检查应返回 `{"ok":true}`。systemd 自动创建并管理 `/var/lib/qingdan`，不要把数据库放入网页目录。Nginx 模板监听 8897、后端监听本机 8767；端口冲突时同时调整对应配置。外部访问还需在服务器防火墙或云安全组放行网页端口。

上述安装命令用于首次部署。更新既有安装前先备份程序及 Nginx 配置；运行中的 SQLite 用 backup API 备份，不要直接只复制主文件。更新代码后 `systemctl restart qingdan`，只改网页时不需要重启后端。

## 部署位置

- 当前项目源码：`/root/ClawChatProjects/open/qingdan`。
- 运行代码：`/opt/qingdan`。
- 静态页面：`/usr/share/nginx/qingdan`。
- SQLite：`/var/lib/qingdan/tasks.sqlite`，由 systemd StateDirectory 管理。
- 后端仅监听 `127.0.0.1:8767`，Nginx 8897 转发 `/api/`。
- systemd：`/etc/systemd/system/qingdan.service`，自动启动及失败重启。

```sh
systemctl status qingdan
journalctl -u qingdan -n 30 --no-pager
systemctl restart qingdan
```

备份运行中的数据库请使用 SQLite backup API，不要仅复制主文件（WAL 可能仍有数据）。

## 接口约定

- GET `/api/tasks` → `{tasks:[{id,title,done,priority,created,version}]}`。
- POST `/api/tasks`，JSON `{title,priority?,requestId?}` → 201 `{task}`；同 requestId 同内容重试返回 200 和同一任务。请求标识与任务一同持久化，服务重启后仍去重。
- PATCH `/api/tasks/:id`，JSON `{version,title?,done?,priority?}` → `{task}`。
- DELETE `/api/tasks/:id?version=N` → `{ok:true}`。
- POST `/api/tasks/import`，JSON `{tasks:[旧任务]}`，幂等合并，已有任务及删除墓碑不覆盖。
- POST `/api/tasks/clear-completed`，JSON `{tasks:[{id,version}]}`，事务删除指定的已完成任务。任何版本变化会拒绝整个批次。
- GET `/api/health` → `{ok:true}`。

修改/删除的版本过期返回 409；已被删除返回 404；非法字段返回 400；数据库故障返回 503。写请求拒绝跨站来源及非 JSON 内容类型，导入最多 10000 条、单请求最多 2000000 字节。

## 设备同步与迁移

每 3 秒同步，窗口重新获得焦点或页面重新可见时立即同步。前端等待写入成功后再更新任务，失败保留输入及错误提示；读取成功不覆盖上次保存失败提示。编辑弹窗保留开始编辑时的版本，发生冲突后需关闭弹窗、查看最新任务再编辑。

旧浏览器 `qingdan-tasks-v1` 首次打开时上传合并，成功后设置 `qingdan-server-migrated-v1`，原始数据保留为本地备份。迁移失败会单独提示并保留备份及未迁移标记，不阻塞已读取的共享清单；格式错误会暂停本次页面会话内的自动重试，刷新后可再次尝试。禁用本地存储不影响新增服务器任务。删除墓碑防止另一台设备的旧备份复活已删除任务。

新增表单对一次未确认成功的提交保留随机 requestId；失败后原内容重试不会重复新增。成功后再次提交同名任务会使用新标识，仍允许两条独立任务；同一标识对应的任务已被删除时返回 409，不复活任务。
