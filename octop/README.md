# Octop 安装版源码与资源快照

本目录保存当前服务器安装版的5个 Octop 组件：

| 组件 | 版本 |
| --- | --- |
| octop | 1.0.2 |
| octop-memory | 1.0.2 |
| octop-gateway | 1.0.3 |
| octop-browser | 1.0.0 |
| octop-harness | 1.0.5 |

上游为 [TencentCloud/Octop](https://github.com/TencentCloud/Octop) 及其配套组件仓库。按安装包 RECORD 选择源码、内置技能和已分发网页资源，复制前逐文件校验原包 SHA-256；保留每个组件的 MIT 许可证、包元信息与入口声明。`SOURCE-INFO.json` 记录版本及一次文档示例脱敏，未改变运行逻辑。

`source/` 是已安装包的运行源码和静态资源，不是上游完整开发工作区；网页已带构建产物，不另行宣称附有未安装的 TypeScript 工程。`package-metadata/` 保存各包的分发元信息和许可证。

## 新机器安装

需要 Python 3.12+、可用的 pip 与系统构建依赖。以下为相同 Python 3.12 布局的新机器示例：

```sh
install -d /opt/octop
python3.12 -m venv /opt/octop/venv
/opt/octop/venv/bin/python -m pip install -r octop/requirements.txt
cp -a octop/source/. /opt/octop/venv/lib/python3.12/site-packages/
install -d -m 0700 /root/.octop
test -e /root/.octop/config.json || install -m 0600 octop/config.example.json /root/.octop/config.json
install -m 0644 octop/deploy/octop.service.example /etc/systemd/system/octop.service
systemctl daemon-reload
systemctl enable --now octop.service
```

命令从 fwq 仓库根目录执行。若 Python 版本、架构或 site-packages 布局不同，先调整路径。`requirements.txt` 固定5个核心组件；`requirements.lock` 是原 Linux 环境214个已安装发行包的版本清单，供相同环境复现时参考，不把它当作所有系统都能无差别安装的锁文件。

`config.example.json` 仅含新机器的本机监听地址和端口13947。原 `/root/.octop/` 中的账号配置、聊天与专家记忆、数据库、浏览器资料、模型文件、插件运行配置和安全密钥未复制，首次使用需完成新机器自身配置。访问方式及所需模型由操作者按实际环境设置。

服务模板保留原来的内存上限与重启限制。与其他业务共同部署前，需要核对新机器总容量和各服务预算；Listing 的独立资源限制不能因此取消。源码检查不代表已在另一台服务器启动或完成账号验证。
