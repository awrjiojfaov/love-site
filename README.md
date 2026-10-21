# 秘密花园 love-site

一个**纯前端**的双人共享小站：两个人各用一台设备登录，数据实时同步，一起养爱情树、经营农场、钓鱼、赌石、写回忆录、存钱罐、打卡地图……

- **纯静态**：构建产物是一坨静态文件，扔到任意静态托管（EdgeOne / Vercel / Netlify / Cloudflare Pages / GitHub Pages / Nginx …）上就能跑
- **无需后端、无需数据库**：数据通过 MQTT broker 在两端实时同步
- **仓库不含任何个人数据**：昵称、密码、域名、服务器、密钥全部通过环境变量或本机文件注入，clone 即得一个干净框架

> 本仓库是完整可运行的通用框架。作者自己部署的实例额外绑定了独立域名与轻量服务器（俗称「满血版」），这只影响部署配置，**代码与普通版完全一致**——见 [普通版 vs 满血版](#普通版-vs-满血版)。

---

## 功能一览

### 🏡 主页 · 在一起
- 在一起的计时时钟、时元（站内货币）余额、主页小猫彩蛋
- 樱花飘落动效，自定义头像与头像框

### 💞 双人互动
- **见闻打分** —— 给彼此的日常见闻打 1–10 分，支持双人追评
- **默契挑战** —— 答题比默契，答对得时元
- **互相提问** —— 你来我往的问答
- **悄悄话** —— 只给对方看的小纸条
- **你画我猜** —— 一人画、一人猜
- **打分转盘** —— 随机转盘抽取小任务

### 🌱 养成经营
- **爱情树** —— 两人共养一棵樱花树，累计经验升级，共 7 种形态
- **农场** —— 20 块地 5 级作物，含偷菜、除虫、合成、鱼塘
- **钓鱼** —— 钓鱼小游戏 + 鱼种图鉴排行
- **存钱罐** —— 一起存钱、记录收支
- **心愿商店** —— 上架心愿、用时元兑换
- **玉石鉴定** —— 赌石 / 工坊加工 / 富贵值
- **拍卖会** —— 竞价拍下心头好

### 📸 记录回忆
- **打卡地图** —— 在地图上打卡记录一起去过的地方（含照片）
- **回忆录** —— 共同书写的时间线

### 🎲 趣味玩法
- **纪念日盲盒** —— 开出一份小惊喜
- **股票** —— 模拟炒股，看涨看跌
- **剧情工坊** —— 接入 AI（DeepSeek / 豆包 / Gemini）生成互动剧情

### 🔧 账号
- 双人账号登录、账号组绑定、管理员管理（可创建多个双人账号组，每组数据完全隔离）

> 部分玩法（歇园、纪念日盲盒等）仅对「默认账号组」开放。

### ⚡ 同步架构（内置四层分诊）

| 层 | 机制 | 适用 | 延迟 |
|---|---|---|---|
| 分片同步 | 点按钮只发自己那一片，双向对齐 | 拍卖会、农场、默契挑战 | 几十 ms |
| 增量同步 | 超 4KB 自动改发 diff | 玉石、钱包、地图等大包 | 毫秒级 |
| 整包直发 | 原样 retained | 心愿商店、礼物、回忆录等小包 | 几 ms |
| 全量直通 | 白名单绕过增量层 | 农场等「写云端真相」的主题 | — |

应用层自带 Lamport 版本号合并、删除墓碑、离线 outbox 补发、持有者回补——broker 换了、retained 被清了，数据也能靠本地备份自动长回来。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | React 19 + TypeScript |
| 构建 | Vite 7（`base: './'`，产物可放任意子路径） |
| 样式 | Tailwind CSS 3 + shadcn/ui |
| 数据同步 | MQTT（mqtt.js，WebSocket / WSS） |
| 本地缓存 | localStorage + IndexedDB |

---

## 普通版 vs 满血版

同一个代码仓库，两种玩法：

| | 普通版 | 满血版 |
|---|---|---|
| 托管 | 免费静态托管（GitHub Pages / Vercel / surge …） | 自有域名 + CDN/静态托管 |
| 数据同步 | 代码内置的公共 MQTT broker | 自建 MQTT broker（轻量服务器） |
| 域名 | 平台送的二级域名 | 自己的顶级域名 + HTTPS |
| 备案 | 不需要 | 中国大陆服务器需 ICP 备案 |
| 成本 | 0 元 | 域名 ~15 元/年 + 轻量服务器 ~100 元/年 |
| 适合 | 先跑起来体验 | 长期两个人正式用 |

**普通版够用吗？** 够。开箱即走公共 broker，功能一样不少。但公共 broker 是全网共享的免费实例：延迟高（几百 ms~秒级）、别人理论上能看到你的主题（所以前缀务必用随机串）、且随时可能清空 retained 数据（站点有本地备份兜底，但体验会打折）。

**满血版的好处：**
1. **数据主权**——broker 跑在自己的服务器上，retained 落盘、每日自动备份，谁也清不掉
2. **速度**——国内服务器 + 国内 CDN，同步延迟从秒级降到几十毫秒，手机上秒开
3. **专属域名**——好记、可挂自己的子域（如 `mqtt.yourdomain.com`），配 HTTPS 证书自动续签
4. **合规放心**——中国大陆服务器 + ICP 备案，不怕被墙、不怕运营商拦截
5. **一台服务器多种用途**——MQTT 之外还能跑对方在线状态、消息回执、图片托管、AI 接口中转等

建议路线：**先用普通版跑通 → 觉得好玩再升级满血版**，两步互不冲突（换 broker 只改 3 个环境变量重新构建）。

---

## 快速开始（普通版）

```bash
git clone <本仓库>
cd love-site
npm install
cp .env.example .env.local     # 按注释填自己的值（见下文）
npm run dev                    # 本地预览
npm run build                  # 得到 dist/
```

把 `dist/` 整个目录上传到任意静态托管即可。`vite.config.ts` 里设了 `base: './'`，产物用相对路径引用资源，放在**根目录或任意子路径**都能正常工作。

站点是单页应用但**不使用 URL 路由**（页面切换是内存状态），所以**不需要配置 SPA 回退规则**。

### 各托管平台

| 平台 | 做法 |
|---|---|
| **腾讯云 EdgeOne Pages** | 官方 CLI：`edgeone login -s china -t <你的Token>` 然后 `edgeone makers deploy ./dist -n <项目名> -a overseas` |
| **Vercel / Netlify / Cloudflare Pages** | 连仓库 → Build command 填 `npm run build`，输出目录填 `dist`；环境变量在平台面板里加（对应 `.env.local` 的那些 `VITE_*`） |
| **GitHub Pages** | 构建后把 `dist/` 推到 `gh-pages` 分支（`base: './'` 已兼容子路径） |
| **自己的 Nginx** | `root /var/www/love-site/dist;`，纯静态即可 |
| **surge** | `npx surge ./dist your-name.surge.sh` |

> ⚠️ 在 CI / 平台面板里构建时，**必须把 `.env.local` 里的 `VITE_*` 配到平台的环境变量里**，否则会退回代码里的默认值，站点会用默认配置运行。

### 首次进入
部署完成后打开站点，用 `VITE_MEMBER_A` / `VITE_MEMBER_A_PASSWORD` 登录，再在主页「账号管理」里把两位成员改成你和 TA（也可以直接改 `.env.local` 后重新构建）。

---

## 环境变量配置

所有配置都通过**构建期环境变量**注入（Vite 只暴露 `VITE_` 前缀的变量）。完整样例见 [`.env.example`](./.env.example)。

**用法**：复制 `.env.example` 为 `.env.local`，按注释填自己的值；`.env.local` 已被 `.gitignore` 忽略，不会进版本库。

| 变量 | 默认 | 说明 |
|---|---|---|
| `VITE_APP_TITLE` | 秘密花园 | 站点标题 / PWA 名称 |
| `VITE_APP_DESC` | 两个人共享的小天地 | 站点描述 |
| `VITE_LOGIN_TITLE` | 我们的小窝 | 登录卡片标题 |
| `VITE_ICP` | 空 | ICP 备案号，留空则不显示（中国大陆自建站才需要） |
| `VITE_MEMBER_A` | 小雨 | 第一位成员昵称 |
| `VITE_MEMBER_B` | 小晴 | 第二位成员昵称 |
| `VITE_ADMIN_NAME` | = MEMBER_B | 管理员昵称（可歇园、建账号组） |
| `VITE_MEMBER_A_PASSWORD` | 0000 | 成员 A 登录密码 |
| `VITE_MEMBER_B_PASSWORD` | 0000 | 成员 B 登录密码 |
| `VITE_ADMIN_PASSWORD` | = MEMBER_B_PASSWORD | 管理员密码 |
| `VITE_TOPIC_PREFIX` | lovesite/ | **数据同步前缀，务必改成自己的**（建议用一段只有你懂的随机串） |
| `VITE_MQTT_PRIMARY_URL` | 空 | 自建 broker 地址，如 `wss://mqtt.example.com/mqtt` |
| `VITE_MQTT_PRIMARY_USER` | 空 | broker 账号（留空表示匿名） |
| `VITE_MQTT_PRIMARY_PASS` | 空 | broker 密码 |
| `VITE_LOVE_START` | 空 | 在一起的起始时刻（ISO，如 `2026-05-15T19:00:00`），留空则由双方在页面自设；纪念日盲盒也依赖它 |
| `VITE_TREE_FLOOR` | 空 | 爱情树历史账本保底（JSON），一般留空 |

**改头像**：直接替换 `src/assets/avatar-a.jpg` / `avatar-b.jpg`（对应 A / B 两位成员）。

**AI 功能（可选）**：剧情工坊支持 DeepSeek / 豆包 / Gemini 三家，API 密钥只在各自手机的页面上填、只存本机 localStorage，不进代码库。Gemini 默认走官方端点，国内网络可在剧情工坊设置里把接口地址改成任意 OpenAI 兼容中转站。

---

## 满血版搭建：域名 + 轻量服务器 + 备案

从普通版升级到满血版，总共四件事。以下为通用流程（不含任何特定厂商，主流云厂商均有同类产品）：

### 第 1 步：买域名 + ICP 备案

1. 在任意域名注册商买一个顶级域名（.top / .cn / .com 均可，十几元/年起）
2. 如果要用**中国大陆**的服务器，必须做 ICP 备案：在云厂商备案系统提交（身份证 + 域名 + 服务器信息，全程线上），一般 1~2 周下号
3. 备案号填进 `.env.local` 的 `VITE_ICP`（站点页脚会自动显示）
4. 只用境外服务器（如 Vercel + 境外 broker）则**不需要备案**

### 第 2 步：买一台轻量应用服务器

- 配置要求很低：**2 核 2G** 起步完全够用（MQTT broker 只转发消息，几乎不吃资源）
- 选离你们近的地域（国内用户选大陆节点，配合已备案域名）
- 系统镜像选 Ubuntu 22.04/24.04 即可
- 防火墙放行 22（SSH）、80/443（HTTP/HTTPS）

### 第 3 步：自建 MQTT broker（Mosquitto + Caddy 自动 HTTPS）

**1. 用 Docker 起 Mosquitto**

```yaml
# docker-compose.yml
services:
  mosquitto:
    image: eclipse-mosquitto:2
    restart: always
    ports:
      - "127.0.0.1:8083:8083"   # WebSocket，只绑本机，交给反代
    volumes:
      - ./mosquitto:/mosquitto/config
      - ./data:/mosquitto/data
```

```conf
# mosquitto/mosquitto.conf
persistence true
persistence_location /mosquitto/data/     # retained 落盘，重启不丢
autosave_interval 30

listener 8083
protocol websockets
allow_anonymous false
password_file /mosquitto/config/passwd
```

```bash
# 建账号（shell 里执行）
docker run --rm -it -v "$PWD/mosquitto:/mosquitto/config" eclipse-mosquitto:2 \
  mosquitto_passwd -c -b /mosquitto/config/passwd 你的账号 '你的密码'
```

**2. 域名解析 + 反代 + 自动 HTTPS（Caddy）**

把一条子域名（如 `mqtt.yourdomain.com`）的 A 记录指向服务器 IP，然后装 Caddy：

```caddyfile
mqtt.yourdomain.com {
    reverse_proxy 127.0.0.1:8083
}
```

Caddy 会自动签发并续签 Let's Encrypt 证书，零配置。

**3. 建议加每日备份（cron）**

```bash
# 每天 4:17 用 mosquitto_sub 把全部 retained 存成快照，保留 30 天
17 4 * * * timeout 30 mosquitto_sub -h 127.0.0.1 -p 1883 -u <账号> -P <密码> -t '#' -R -F '%t %p' | gzip > /opt/backup/retained-$(date +\%F).txt.gz && find /opt/backup -mtime +30 -delete
```

> ⚠️ Mosquitto 配置里 WebSocket 监听只绑 127.0.0.1，公网入口只有 Caddy 的 443（TLS + 可加账号认证），不要把 1883/8083 直接暴露到公网。

### 第 4 步：接入网站

```dotenv
# .env.local 追加三行，重新构建部署即可
VITE_MQTT_PRIMARY_URL=wss://mqtt.yourdomain.com/mqtt
VITE_MQTT_PRIMARY_USER=你的账号
VITE_MQTT_PRIMARY_PASS=你的密码
```

前端托管不变（仍可用免费静态托管，或托管到同一家云厂商的 CDN 上获得国内加速）。

> 代码内置了「主 broker 挂了自动切公共备胎」的故障转移，所以即使自建机器短暂下线，站点也不会彻底失联；修复后新会话自动回归主通道。

---

## 常见问题

**Q：不配 broker 直接用行不行？**
能跑，但会落在公共 broker 上，数据不受你控制。仅供试玩，正式用建议自建。

**Q：两台设备不同步？**
先看设备是否都能连上 broker（断线时页面会有横幅）；再确认两台设备用的是**同一个主题前缀**（即同一份 `.env.local` 构建出来的站点）。

**Q：怎么改成员昵称 / 密码？**
改 `.env.local` 后重新构建部署。管理员密码同时决定「账号管理」入口的可见性。

**Q：可以用它做多组账号吗？**
可以。管理员登录后可在「账号管理」创建多个双人账号组，每组自动分配独立主题前缀，数据互不可见。

**Q：换头像怎么弄？**
替换 `src/assets/avatar-a.jpg` / `avatar-b.jpg` 后重新构建。

**Q：安全吗？会不会泄露我们的数据？**
- 站点没有服务器端存储，业务数据只存在于：你手机本地（localStorage/IndexedDB）+ broker 的 retained 消息
- 自建 broker + 账号密码 + TLS = 只有知道凭据的设备能连；主题前缀再用随机串加固一层
- AI 密钥只存各自手机 localStorage，不经过任何第三方
- 仍建议：默认账号组的密码别用弱密码；broker 密码定期换
