# 闲鱼监控部署

使用 [ai-goofish-monitor 上游项目](https://github.com/Usagi-org/ai-goofish-monitor/tree/77f8d75869acd65f9dba72731b95c7c49ea67bdf) 的应用镜像。[Compose 配置](compose.yaml) 固定部署时的镜像摘要，将后台绑定在 `127.0.0.1:8000`。对外入口走 [site-access](../site-access/README.md) 的 8798 端口，应用登录保护调研和账号接口。

1. 复制 `.env.example` 为 `.env`，填入本机 Buddy2api 客户端密钥和新管理员密码，将文件权限设为 600。
2. 创建 `data`、`state`、`prompts`、`jsonl`、`logs`、`images` 和 `price_history` 目录，按需从上游复制初始提示词。用 `{}` 初始化 `config.json`。已有部署时沿用原配置与数据。
3. 执行 `docker compose up -d` 创建项目网桥。安装 [Buddy2api 转发模板](ops/ai-goofish-buddy-proxy.service.example) 并启用对应服务，要求安装 socat，Buddy2api 监听本机 18878 端口。如果 Docker 子网冲突，在 Compose、容器宿主机映射和转发模板里一并替换子网和网关。
4. 用应用管理员账号登录 8798。需要运行监控时，在网页导入自己的闲鱼登录态并建立任务。

AI 连接使用 Buddy2api 的 `auto` 模型。应用关闭强制 JSON 响应格式，仍按提示词读取模型输出。
