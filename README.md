# Warrior Base · 冒险公会

课程配套的**学员作品展示站**。孩子（或任何学员）把做出来的小工具、截图和分享链接贴上来，形成一面可浏览的作品墙；平台只保存作品介绍、截图和外链，**不托管代码，也不替作品做数据同步**。

## 它做什么

- **公共作品广场**：一件作品一张卡，按讲次筛选，支持昵称与标题搜索、分页。
- **个人展台**：一个账号每讲一件作品，配独立截图；没传图就显示占位图标。
- **投稿与审核**：草稿、投稿、编辑、隐藏；公开版本与新审核版本分开，改动不会立刻顶掉线上那版。
- **AI 审核**：文字与图片送多模态模型检查，失败或结果不确定时保留待审，不会误放行。
- **互动**：登录后点赞／取消，每账号每作品一票，不能自投；匿名可举报。
- **联络站**：管理员配置公告、公众号二维码、可设过期时间的群二维码；过期或关闭的一律不外露。
- **账号**：用户名＋密码注册，默认保持登录；忘记密码用「用户名＋注册手机号」匹配重置，不发短信。

## 快速开始

需要 Node.js 22.13 或以上。

```sh
npm ci
npm run dev
```

打开 `http://127.0.0.1:5173`。

未配置审核服务时，开发脚本会进入**本机演示模式**：使用隔离的 `data/local-demo`，并且禁止 production 或非回环监听。演示模式的审核放行只是为了让界面能走通，**不等于真实 AI 检查**。

要接真实审核，复制 `.env.example` 为 `.env`，填好服务端 `MODERATION_API_KEY` 后再启动。

## 配置

`server/` 读取的是服务端环境变量，前端不持有任何密钥。主要项：

| 变量 | 作用 |
|---|---|
| `APP_ORIGIN` | 站点对外地址，用于 Origin 校验与会话 Cookie |
| `DATA_DIR` | SQLite 与图片的落盘目录 |
| `PHONE_HASH_SECRET` | 手机号哈希盐，上线必须替换 |
| `LOCAL_DEMO` | `1` 时启用本机演示模式，生产必须为 `0` |
| `TRUST_PROXY` | 走反向代理时置 `1`，直连不要开 |
| `DEPLOYMENT_DOMAINS` | 允许学员提交的作品分享域名白名单，逗号分隔 |
| `MODERATION_API_KEY` / `MODERATION_BASE_URL` | 审核服务凭据与 OpenAI 兼容端点 |
| `MODERATION_TEXT_MODEL` / `MODERATION_VISION_MODEL` | 文本与图片审核模型 |

完整清单见 [.env.example](.env.example)。默认适配阿里云百炼的 `qwen-flash` 与 `qwen3-vl-flash`；换别的供应商就实现 [server/moderation.js](server/moderation.js) 里那层窄接口。

## 生产运行

```sh
npm ci --omit=dev
# 前端 dist 需先在构建环境生成
npm run build
NODE_ENV=production node --env-file=/path/to/private.env server/index.js
```

生产环境必须设置 `APP_ORIGIN`、`PHONE_HASH_SECRET`，并保持 `LOCAL_DEMO=0`。进程监听回环地址，由 Nginx 终止 HTTPS 并反代进来；`deploy/` 下给了 systemd 与两份 Nginx 模板（记得把 `guild.example.com` 换成自己的域名）。

管理员用 CLI 创建，没有默认密码：

```sh
node server/admin.js create <用户名>
```

参考拓扑、备份与升级流程见 [docs/DEPLOY.md](docs/DEPLOY.md)，接口约定见 [docs/api-contract.md](docs/api-contract.md)。

## 安全与已知边界

- **手机号没有验证过**。知道用户名和号码的人可以重置普通账号——这是首版接受的取舍，靠基础限流和号码不公开降低风险，但消除不了。别在这套账号体系里放付费、奖品或私密数据而不重新评估。
- **通用 LLM 初筛不是内容安全认证**。审核只覆盖本站提交的文字与图片；作品链接只校验 HTTPS 和域名白名单，不抓取、不审核其中内容。
- 图片单次 ≤2MB、≤16MP，落盘前重新编码为 WebP 并剥掉元数据；图片不是公开静态目录，按引用关系鉴权。
- 单进程 SQLite 加本地图片适合中小规模，没有做大规模压测。
- 首版无邮件／短信／IM 主动提醒，管理员需自己进后台看异常；**不要宣称无人值守**。

## 测试

```sh
npm test          # API、审核适配、链接校验
npm run build
npm run test:browser   # 需要 npx playwright install chromium
```

浏览器用例只对本机演示模式写数据，覆盖注册、投稿、跨刷新保持登录、筛选、移动端布局、找回与点赞。测试不连真实审核服务。

## License

MIT，见 [LICENSE](LICENSE)。**换上自己的课程内容**：`src/App.jsx` 顶部的 `ORG_NAME`、`COURSE_TITLE` 和 `LESSONS` 三块常量——讲次名称、每讲说明、封面图都在那里，封面留 `null` 就用占位图标。
