# 网页访问入口

收录当前服务器的独立 Node.js 网页入口及访问密码设置界面。`server.cjs` 将各业务转发到本机后端；`settings-ui.js` 提供访问设置入口。原服务的口令哈希、会话、Octop私有认证密钥以及浏览器测试截图均未收录。

部署前须按目标机器调整 `sites` 列表、各本机上游地址和公网端口，准备 `/opt/site-access/octop.key` 及私有状态文件，先为准备暴露的每个站点配置密码，再开启服务和防火墙。`state.json` 不存在或某个站点没有密码记录时，该站点会免密码访问；不要直接复制并公网启动空状态。

状态文件格式为站点ID到 `{salt,hash,version}` 的映射：salt为随机16字节的十六进制值，hash为Node `crypto.scryptSync(password,salt,32)` 的十六进制值，version为随机值。所有值必须在目标机器重新生成，状态文件权限600。`STATE_FILE`可指定状态路径，业务账号/API密钥与入口密码分开保存。

服务模板在 `site-access.service.example`。业务后端只监听本机；此基础入口为HTTP，当前源码的登录/改密码与WebSocket来源校验使用 `http://Host`。若放在HTTPS代理后，代理必须先核对真实HTTPS Origin，再对可信上游规范化HTTP Origin（WebSocket同样处理），或者另行实现受信的转发协议支持；不能仅加TLS便视为可用。公网开放前验证登录、来源校验与WebSocket转发。现有站点关闭/重启入口会重置内存会话，操作前考虑正在使用的连接。

轻单与DeepSeek Harness的运行入口已移除；仓库内旧轻单源码只归档，不因安装本入口而恢复。
