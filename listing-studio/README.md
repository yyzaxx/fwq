# Listing Studio

商品图片调研与英文标题工作台，包含中文网页、Node.js 后端、自动化测试，以及专用浏览器和资源保护的部署配置。

- 图片和 ZIP 批量上传，逐张串行执行 Amazon / Sif 调研。
- 保存与选择两套标题模板，核验词源、固定文字和字符数。
- 查看与下载报告，删除单条或整批历史记录。
- 一键恢复全部暂停任务；最多保留 2 个业务标签页。
- 任务间按占用回收专用浏览器；共享 1GiB 内存与 512MiB 交换空间硬预算。

## 目录

- `web/`：网站完整源码及测试，详细说明见 [web/README.md](web/README.md)。
- `browser/start.sh`：Chromium、Xvfb、noVNC 专用浏览器启动脚本。
- `ops/listing-browser.service`：浏览器 systemd 服务；网站服务和资源限制配置位于 `web/ops/`。

## 检查

需要 Node.js 22 或更高版本、Python 3 和 ImageMagick。网站没有第三方 npm 运行依赖。

```sh
cd web
npm test
npm run check
```

执行真实调研还需要已认证的本机 Codex、部署在 `/root/.codex/skills/ai-listing/` 的技能及其引用文件，以及已登录的 Amazon / Sif 专用浏览器。这些账号、技能运行配置和登录资料需在部署机器单独准备。

## 部署约定

配置示例使用 `/root/ClawChatProjects/listing/`：将 `web/` 和 `browser/` 放入该目录，按 `web/README.md` 安装服务及共同资源限制。浏览器服务模板在 `ops/listing-browser.service`，网站服务模板在 `web/ops/listing-web.service`。其他目录或用户部署时需调整路径、服务用户与执行器技能位置。

Node 服务只监听本机 7350；浏览器控制端口只监听本机 9223，桌面服务只监听本机 6081。对外访问通过自身 Nginx 入口。随机私人访问路径保存在运行机器的 `web/.runtime.json`，不进入版本库。

此目录是源码快照，不包含任务记录、商品图片、报告、模板库、Cookie、浏览器 profile、账号密钥、日志或私人访问路径。2026-11-10 上传前 89 项自动测试及语法检查通过。
