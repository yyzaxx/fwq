# Buddy2api：WorkBuddy 模型接口

收录服务器已验证的 Buddy2api v2.2.24 上游源码、许可证、依赖及脱敏部署模板。上游为 [wicm84266964/Buddy2api](https://github.com/wicm84266964/Buddy2api)，版本和提交见 `UPSTREAM.json`。上游完整说明位于 [source/README.md](source/README.md)，本目录不代表上游官方发布渠道。

本机提供 `/v1/models`、`/v1/chat/completions` 和 `/v1/responses`。网页提供账号、模型、客户端密钥及用量管理。模型使用本人账号的额度，不包含模型权重或额外免费额度。

## 安装与本机服务

按新机器系统准备 Python 3.11+、venv、Git、Nginx 和 systemd。当前部署以 Python 3.11 验证；原始上游推荐 Python 3.12。以下只在明确的新目标服务器执行，已有安装先检查和备份。

```sh
install -d /opt/buddy2api
cp -a buddy2api/source/. /opt/buddy2api/
python3 -m venv /opt/buddy2api/.venv
/opt/buddy2api/.venv/bin/python -m pip install -r /opt/buddy2api/requirements.txt
id -u buddy2api >/dev/null 2>&1 || useradd --system --home-dir /var/lib/buddy2api --shell /sbin/nologin buddy2api
install -d -m 0700 -o buddy2api -g buddy2api /var/lib/buddy2api /var/lib/buddy2api/empty-auth
install -m 0600 buddy2api/ops/buddy2api.env.example /etc/buddy2api.env
```

将 `/etc/buddy2api.env` 中的管理令牌占位值换为新生成的随机值，权限保持600。不要使用占位值运行公网管理页。

```sh
install -m 0644 buddy2api/ops/buddy2api.service.example /etc/systemd/system/buddy2api.service
systemctl daemon-reload
systemctl enable --now buddy2api.service
curl --fail http://127.0.0.1:18878/health
```

服务只监听 `127.0.0.1:18878`，使用独立系统用户，数据在 `/var/lib/buddy2api`；内存软限256MiB、硬限384MiB。只启用 WorkBuddy 通道，额外签到、定时续期、自动账号导入和匿名模型调用关闭。

## 登录和模型验证

首次没有账号。通过本机页面或SSH转发进入管理页，在设置中填写本机生成的管理令牌，然后用“浏览器登录”授权自己的 WorkBuddy 账号。国内与国际版按实际账号选择，国际版还需显式启用相应通道。原账号、登录令牌和当前生产密钥均不在仓库里。

在“API Keys”新建绑定 WorkBuddy 通道的客户端密钥，客户端地址为 `http://127.0.0.1:18878/v1`，以 `/v1/models` 返回的ID为准，先用 `auto` 进行一次小请求测试。管理令牌与模型API密钥是两种不同凭据。

当前服务器实测普通聊天回复“连接成功”，Responses返回completed及正文，重启后账号和密钥保留；这些结果不代表新的机器已经完成登录。不要为了部署而自动切换其他应用的模型设置。

## 可选：复用已有 WorkBuddy Daily 登录

`ops/sync-account.py` 只从已有 `/opt/workbuddy/state/wb_refresh_tokens.json` 读取本人一个账号的有效访问令牌，首次将所选账号标识保存到 `/etc/buddy2api-account.json`。它不导入、不轮换刷新令牌；原签到程序仍负责刷新，避免两个程序争用同一刷新凭据。

只有新机器已部署本人 WorkBuddy Daily、其状态结构与脚本一致时，才安装并启用同步：

```sh
install -d -m 0700 /opt/buddy2api-ops
install -m 0700 buddy2api/ops/sync-account.py /opt/buddy2api-ops/sync-account.py
/opt/buddy2api/.venv/bin/python /opt/buddy2api-ops/sync-account.py
install -m 0644 buddy2api/ops/buddy2api-sync.service.example /etc/systemd/system/buddy2api-sync.service
install -m 0644 buddy2api/ops/buddy2api-sync.timer.example /etc/systemd/system/buddy2api-sync.timer
systemctl daemon-reload
systemctl enable --now buddy2api-sync.timer
```

该方案每5分钟检查访问令牌变化。没有 Daily 时，直接使用上游浏览器登录流程，不启用同步任务。

## 可选：通过服务器IP访问HTTPS网页

`ops/nginx-acme.conf.example` 是首次签发证书用的HTTP入口；将 `YOUR_BIND_IP` 替换为本机网卡实际绑定地址，`YOUR_PUBLIC_IP` 替换为自己的公网IP。云NAT环境这两个地址可能不同。先开放目标服务器的80/443入站，验证HTTP挑战路径可从公网访问。

安装 Certbot 5.4+；当前实测5.10.0。只加载HTTP验证模板，随后在目标机器签发IP证书：

```sh
install -d -m 0755 /var/lib/buddy2api-acme
certbot certonly --webroot -w /var/lib/buddy2api-acme \
  --ip-address YOUR_PUBLIC_IP --preferred-profile shortlived \
  --cert-name buddy2api-ip
```

IP证书有效期较短，须配置自动续期。签发成功后再使用 `ops/nginx-public.conf.example`，其中页面及管理接口要求独立网页登录，公网不开放模型 `/v1`。使用 `htpasswd` 在目标机器创建 `/etc/nginx/buddy2api.htpasswd`，权限设为Nginx worker可读；账号密码由操作者自行设置。

`ops/buddy2api-admin-proxy.inc.example` 的占位值须换成同一目标机器的管理令牌，保存为 `/etc/nginx/buddy2api-admin-proxy.inc`，仅root可读。私有配置不提交GitHub。代理会将管理令牌注入上游请求，不交给浏览器；跨站管理请求被拒绝。页面代理隐藏备用管理令牌框，并清除前端Bearer头，避免与网页登录冲突。

证书续期服务模板中的Certbot可执行路径 `/opt/buddy2api-ops/certbot/bin/certbot` 要按实际安装路径校正。安装 `.service.example`、`.timer.example` 对应文件后，每6小时检查续期，续期成功重载Nginx。启用前跑 `nginx -t`、模拟证书续期，并用真实浏览器验证登录。

## 排除与维护

不包含账号令牌、手机号码、管理员口令、客户端API Key、数据库、加密密钥、证书私钥、日志、截图或依赖虚拟环境。数据库和其凭据加密密钥只在私有备份中一并保存。程序目录只读，升级需要管理员备份、更新依赖并重启；不要通过公开管理页覆盖其他业务配置。
