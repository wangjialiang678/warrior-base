# 部署参考

单机参考拓扑：一台 Linux 服务器跑 Node 进程，Nginx 终止 HTTPS 并反代到回环端口，数据落在服务用户可写的独立目录。

```
浏览器 ──HTTPS──> Nginx :443 ──proxy──> 127.0.0.1:4310 (node server/index.js)
                                              │
                                              └──> $DATA_DIR (SQLite + 图片)
```

## 目录约定

| 路径 | 用途 |
|---|---|
| `/opt/warrior-base/releases/<版本>` | 每次发布一个不可变目录 |
| `/opt/warrior-base/current` | 软链，指向当前在跑的版本 |
| `/var/lib/warrior-base` | 数据与图片，`0700`，只归服务用户 |
| `/var/lib/warrior-base/backups` | 发布前的数据快照 |
| `/etc/warrior-base.env` | 环境变量，`0640` root:服务组 |

关键原则：**代码目录和数据目录分离**。升级只切软链，绝不动数据目录。

## 首次部署

1. 建专用非登录用户：

   ```sh
   sudo useradd --system --home /var/lib/warrior-base \
        --shell /usr/sbin/nologin warrior-base
   sudo install -d -m 700 -o warrior-base -g warrior-base /var/lib/warrior-base
   ```

2. 本机构建前端，连同源码上传到 `/opt/warrior-base/releases/<版本>`。上传时排除 `data/`、`node_modules/`、`.env`、`test-results/`、`dist/` 之外的构建缓存。

3. 服务器安装生产依赖并生成前端产物（若未在本地构建）：

   ```sh
   cd /opt/warrior-base/releases/<版本>
   npm ci --omit=dev
   npm run build
   ```

4. 写 `/etc/warrior-base.env`。`PHONE_HASH_SECRET` 用 `openssl rand -hex 32` 现生成，`APP_ORIGIN` 填对外地址，`LOCAL_DEMO=0`、`TRUST_PROXY=1`。文件权限 `0640 root:warrior-base`。

5. 建管理员（交互输入密码，不接受 argv 传参）：

   ```sh
   sudo -u warrior-base env $(cat /etc/warrior-base.env | xargs) \
        node server/admin.js create <用户名>
   ```

6. 切软链、装服务、起进程：

   ```sh
   sudo ln -sfn /opt/warrior-base/releases/<版本> /opt/warrior-base/current
   sudo cp deploy/warrior-base.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now warrior-base
   curl -fsS http://127.0.0.1:4310/api/health
   ```

7. Nginx 按 `deploy/nginx-*.conf.example` 配好并签发证书。先用 HTTP challenge 路径把域名验证过，再上 HTTPS 配置，避免签发时被 301 打断。

8. 管理员进 `/admin` 的「联络站设置」填公众号名称、说明并上传二维码；群二维码设有效期。这些不改代码。

## 每发布前先备份

```sh
sudo -u warrior-base env DATA_DIR=/var/lib/warrior-base \
     /usr/bin/node scripts/backup.mjs
```

脚本走 SQLite 的备份接口存两个数据库并复制图片，输出带时间戳的目录。**别只备份代码**——代码可以重建，学员作品不能。

## 升级与回滚

1. 新建 release 目录，传代码，装依赖。
2. 备份数据。
3. `ln -sfn` 切 `current`，`systemctl restart warrior-base`。
4. 核验 `curl -fsS http://127.0.0.1:4310/api/health` 与首页关键交互。

回滚就是把软链指回上一个 release 再重启。上一个版本至少保留一个，运行中的和数据迁移相关的版本不要随手删。**如果这次发布带了数据库迁移，先确认与旧代码兼容**，不能盲目回退。

## 下线与维护

要临时停站，让 Nginx 返回 503 或维护页，重载配置前先 `nginx -t`。不要为了下线去清空数据库或删别的站点。

## 单机方案的边界

单进程 SQLite 加本地图片不是无限容量方案。上传限制、压缩和审核额度都是首版控资源的手段，没有做过大规模压测；真要放量，先拆出对象存储和独立数据库，再谈多实例。
