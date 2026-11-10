# Listing Studio

商品图片调研与英文标题工作台，包含中文网页、Node.js 后端、自动化测试，以及专用浏览器和资源保护的部署配置。

- 图片和 ZIP 批量上传，逐张串行执行 Amazon / Sif 调研。
- 保存与选择两套标题模板，核验词源、固定文字和字符数。
- 查看与下载报告，删除单条或整批历史记录，用原图和模板重新开始任务。
- 一键恢复全部暂停任务；最多保留 2 个业务标签页。
- 任务间按占用回收专用浏览器；共享 1GiB 内存与 512MiB 交换空间硬预算。

## 目录

- `web/`：网站完整源码及测试，详细说明见 [web/README.md](web/README.md)。
- `ai-listing/`：真实调研与标题生成使用的技能及全部引用规范。
- `browser/start.sh`：Chromium、Xvfb、noVNC 专用浏览器启动脚本。
- [browser/README.md](browser/README.md)：远程浏览器依赖、网站与 CDP/noVNC 的连接关系、首次部署、登录接管及排错。
- `ops/listing-browser.service`：浏览器 systemd 服务；网站服务和资源限制配置位于 `web/ops/`。
- `ops/nginx-server.conf.example`：网站与远程浏览器共用的独立 Nginx 入口模板，包含 noVNC WebSocket 反代。

## 检查

需要 Node.js 22 或更高版本、Python 3 和 ImageMagick。网站没有第三方 npm 运行依赖。

```sh
cd web
npm test
npm run check
```

执行真实调研还需要已认证的本机 Codex，以及已登录的 Amazon / Sif 专用浏览器。技能及全部引用文件现已收录在 `ai-listing/`，按部署说明安装到 `/root/.codex/skills/ai-listing/`；账号认证和浏览器登录需在部署机器单独完成。

## 部署约定

完整部署步骤见 [远程浏览器与网站一起部署](browser/README.md)。配置示例使用 `/root/ClawChatProjects/listing/`：将 `web/`、`browser/` 和 `ai-listing/` 放入该目录，安装两个服务及共同资源限制，再配置同源 Nginx 入口。浏览器服务模板在 `ops/listing-browser.service`，网站服务模板在 `web/ops/listing-web.service`。其他目录或用户部署时需调整路径、服务用户与执行器技能位置。

Node 服务只监听本机 7350；浏览器控制端口只监听本机 9223，桌面服务只监听本机 6081。对外访问通过自身 Nginx 入口。随机私人访问路径保存在运行机器的 `web/.runtime.json`，不进入版本库。

此目录是源码快照，不包含任务记录、商品图片、报告、模板库、Cookie、浏览器 profile、账号密钥、日志或私人访问路径。2026-11-10 上传前 100 项自动测试及语法检查通过。
