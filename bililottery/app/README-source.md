# BiliLottery Web 源码版

本包包含完整 Web 前端、Node.js 后端、桌面版共用源码、自动抽奖引擎、测试及依赖锁文件。上游引擎为 LotteryAutoScript v2.11.3，具体提交见 SOURCE-INFO.json。依据 GPL-3.0-or-later 分发，许可证见根目录与引擎目录 LICENSE。

## 安装和启动

需要 Node.js 22 或更新版本，以及首次安装依赖时的联网环境。

Windows：解压到一个新目录，双击 `install-web.cmd`。安装完成后双击 `启动Web版.cmd`，在浏览器打开 http://127.0.0.1:8787 。服务运行时保留命令窗口。

也可在解压目录运行：

```powershell
npm.cmd --prefix engine/LotteryAutoScript ci --omit=dev
npm.cmd run web
```

macOS/Linux 将以上命令中的 `npm.cmd` 改为 `npm`；首次运行同样使用 http://127.0.0.1:8787 。Web 服务自身仅依赖 Node.js 内置模块，无需安装 Electron。

## 首次配置

1. 在“账号与引擎”页填写自己的 B 站 UID，保存后扫码登录。
2. 在“每日汇总”页启用该汇总作为唯一来源，填写汇总 UP UID `492426375` 并保存。此模式只参与该 UP 汇总中的互动抽奖、预约抽奖。
3. 点击“读取汇总预览”，检查来源与截止时间。模拟模式下不会执行真实互动；确认后自行切换真实模式并启动。
4. 如需自动清理，在“每日汇总”启用开奖后清理。每次任务启动时，只清理本程序记录的、开奖已超过 24 小时的本账号转发；无法确认来源的历史动态不会清理。

运行时按条目读取参数并执行，没有启动前整批动态校验。支持任务停止、实时日志与 PNG 登录二维码。

## 数据和配置

这个公开源码包不包含任何个人账号配置、Cookie、参与历史、日志或 node_modules。首次启动为全新账号状态和模拟模式。依赖通过锁文件安装。

新数据写入 `web-data/`，不要将该目录再上传或分享。同一账号的桌面版与 Web 版请择一运行，避免独立参与历史导致重复互动。

默认只允许本机浏览器访问；本包没有部署公网抽奖控制台。修改端口可设置 `BILI_WEB_PORT` 环境变量。更多说明见 `web/README.md`。

## 验证

依赖安装完成后，在项目目录运行 `node --test test/*.test.cjs`。测试采用离线接口验证参与和删除逻辑，不会执行真实抽奖或删帖。

上游仓库：https://github.com/shanmiteko/LotteryAutoScript
