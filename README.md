# DeepSeek 识图代理：给 DeepSeek 装上眼睛

> 让 DeepSeek 看懂图片的透明代理方案 —— DeepSeek（大脑）+ GLM-4.6V-Flash（眼睛）

---

## 目录

1. [这是什么](#1-这是什么)
2. [架构原理](#2-架构原理)
3. [完整搭建步骤](#3-完整搭建步骤)
4. [项目结构](#4-项目结构)
5. [核心代码解析](#5-核心代码解析)
6. [工作经验与教训](#6-工作经验与教训)
7. [故障排查手册](#7-故障排查手册)

---

## 1. 这是什么

### 一句话

一个 Express 中间人代理，拦截发给 DeepSeek 的请求，如果发现消息里有图片，先调用 GLM-4.6V-Flash（完全免费的视觉模型）识别图片内容，然后把图片替换成文字描述，再转发给 DeepSeek 处理。

### 为什么需要它

| 问题 | 方案 |
|------|------|
| DeepSeek 是纯文本模型，不支持图片输入 | 用 GLM 做视觉识别，把图转文字 |
| GLM-4.6V-Flash 免费但容易 429 限流 | 队列串行化 + 指数退避重试 |
| WorkBuddy 等客户端会重复发送同一张图 | 60 秒图片缓存去重 |

### 命名

- **项目名**：`deepseek-proxy` / DeepSeek 识图代理
- **架构名**：DeepSeek + GLM Vision Proxy
- **简称**：DS-Vision Proxy

---

## 2. 架构原理

```
┌─────────────────┐     HTTP POST      ┌──────────────────────────────────────┐
│                 │  (含 image_url)     │                                      │
│   WorkBuddy     │ ──────────────────► │         DeepSeek 识图代理            │
│   / 任何客户端   │                    │         (Express, port 3001)          │
│                 │ ◄────────────────── │                                      │
└─────────────────┘     SSE 流式回复    │  ┌──────────┐    ┌───────────────┐   │
                                         │  │ 图片缓存  │    │   GLM-4.6V    │   │
                                         │  │ (Map,    │───►│   -Flash      │   │
                                         │  │  60sTTL) │    │  (识图)       │   │
                                         │  └──────────┘    └──────┬────────┘   │
                                         │                          │ 文字描述   │
                                         │                          ▼           │
                                         │  ┌──────────────────────────────┐    │
                                         │  │       DeepSeek Chat          │    │
                                         │  │   (最终回答，纯文本)          │    │
                                         │  └──────────────────────────────┘    │
                                         └──────────────────────────────────────┘
```

### 请求流程时序

```
客户端                    代理                    GLM视觉              DeepSeek
  │                       │                       │                    │
  │── POST (含图片) ──────►                       │                    │
  │                       │── 检测到图片 ──────────►                    │
  │                       │── 调用识图 ───────────►                    │
  │                       │◄── 图片描述 ───────────                    │
  │                       │── 描述注入到消息 ──────►                   │
  │                       │── 转发给DeepSeek ──────►                  │
  │◄── SSE 流式回复 ──────│◄──────────────────────│                    │
```

---

## 3. 完整搭建步骤

### 3.1 准备工作

- 一个 GitHub 账号
- 一个 Sealos 账号（国内区，杭州节点）
- 智谱开放平台账号（https://open.bigmodel.cn）
- DeepSeek API Key

### 3.2 本地初始化

```bash
# 创建项目
mkdir deepseek-proxy && cd deepseek-proxy
npm init -y
npm install express dotenv

# 创建配置模板
cat > .env.example << 'EOF'
# DeepSeek API Key（必填）
DEEPSEEK_API_KEY=sk-your-deepseek-key-here

# DeepSeek API 地址（默认官方）
DEEPSEEK_BASE_URL=https://api.deepseek.com

# 默认使用的 DeepSeek 模型
DEEPSEEK_MODEL=deepseek-chat

# 视觉模型 API Key（智谱 GLM，在 open.bigmodel.cn 获取）
VISUAL_API_KEY=your-glm-key-here

# 视觉模型 API 地址（智谱 OpenAI 兼容端点）
VISUAL_BASE_URL=https://open.bigmodel.cn/api/paas/v4

# 视觉模型名称（GLM-4.6V-Flash 完全免费）
VISUAL_MODEL=glm-4.6v-flash

# 代理服务端口
PORT=3001
EOF

cp .env.example .env
# 编辑 .env 填写真实的 Key
```

### 3.3 核心代理代码

见 [proxy.js](proxy.js)，核心函数：

| 函数 | 作用 |
|------|------|
| `hasImages()` | 检测最新用户消息是否包含图片 |
| `extractImages()` | 提取最新用户消息中的图片 URL |
| `stripImages()` | 清理所有消息中的 image_url（发往 DeepSeek 前必须） |
| `injectDescription()` | 把 GLM 识图结果注入到消息中，替换图片 |
| `doRecognizeImages()` | 调用 GLM-4.6V-Flash 识图（含 429 重试） |
| `handleChat()` | 核心处理入口：识图 → 注入 → 转发 DeepSeek |
| `streamToDeepSeek()` | SSE 流式转发到 DeepSeek |

### 3.4 Docker 化

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --registry=https://registry.npmmirror.com
COPY . .
EXPOSE 3001
CMD ["node", "proxy.js"]
```

> 国内网络使用 `--registry=https://registry.npmmirror.com` 加速。

### 3.5 GitHub Actions 自动构建

在 `.github/workflows/build.yml` 中配置，推送到 master 分支时自动构建 Docker 镜像并推送到 GitHub Container Registry（`ghcr.io`）。

```yaml
name: Build and Push Docker Image

on:
  push:
    branches: [master]
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ghcr.io/${{ github.repository }}:latest
```

### 3.6 Sealos 部署

#### 第一步：创建应用

在 Sealos 控制台 → 应用管理 → 创建应用：

| 配置项 | 值 |
|--------|-----|
| 应用名称 | `deepseek-proxy` |
| 镜像地址 | `ghcr.io/你的用户名/deepseek-proxy:latest` |
| 端口 | `3001` |
| CPU | `100m~500m` |
| 内存 | `128Mi~256Mi` |

#### 第二步：配置环境变量

在 Sealos 应用的环境变量中设置：

| 变量 | 值 |
|------|-----|
| `DEEPSEEK_API_KEY` | 你的 DeepSeek Key |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | `deepseek-chat` |
| `VISUAL_API_KEY` | 智谱开放平台的 Key |
| `VISUAL_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` |
| `VISUAL_MODEL` | `glm-4.6v-flash` |
| `PORT` | `3001` |

#### 第三步：获取地址

部署完成后，Sealos 会分配一个公网地址，类似：
```
https://xxxxx.sealoshzh.site
```

#### 第四步：配置 WorkBuddy

在 WorkBuddy 的自定义模型设置中填入：
```
https://xxxxx.sealoshzh.site/v1
```

### 3.7 部署更新流程

每次代码修改后推送上线：

```bash
git add .
git commit -m "描述修改内容"
git push                           # GitHub Actions 自动构建
# → 去 Sealos 重启应用（会拉取最新镜像）
```

---

## 4. 项目结构

```
deepseek-proxy/
├── proxy.js              # 核心代理代码
├── package.json          # Node.js 项目配置
├── Dockerfile            # 容器镜像构建
├── .env                  # 本地环境变量（不要提交）
├── .env.example          # 环境变量模板
├── service.yaml          # Sealos 部署配置（参考用）
├── .github/
│   └── workflows/
│       └── build.yml     # GitHub Actions 自动构建
└── node_modules/         # 依赖
```

---

## 5. 核心代码解析

### 5.1 图片检测：只检查最新消息

```javascript
function hasImages(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") return false;
    if (Array.isArray(content)) {
      return content.some((part) => part.type === "image_url");
    }
    return false;
  }
  return false;
}
```

> **关键经验**：必须从后往前遍历、只检查最新一条用户消息。遍历所有消息会导致历史图片也被触发识图。

### 5.2 队列串行化（防止限流）

```javascript
const visualQueue = [];
let visualBusy = false;
const VISUAL_GAP_MS = 1500; // 请求间隔 1.5 秒

async function processVisualQueue() {
  if (visualBusy || visualQueue.length === 0) return;
  visualBusy = true;
  while (visualQueue.length > 0) {
    const { resolve, reject, params } = visualQueue.shift();
    // 确保间隔
    const now = Date.now();
    const sinceLast = now - visualLastCallTime;
    if (sinceLast < VISUAL_GAP_MS && visualLastCallTime > 0) {
      await new Promise((r) => setTimeout(r, VISUAL_GAP_MS - sinceLast));
    }
    // ... 调用识图
  }
  visualBusy = false;
}
```

### 5.3 指数退避重试（应对 429）

```javascript
for (let attempt = 0; attempt < 5; attempt++) {
  if (attempt > 0) {
    const wait = Math.pow(2, attempt + 1) * 1000; // 4s, 8s, 16s, 32s, 64s
    await new Promise((r) => setTimeout(r, wait));
  }
  // ... 调用
  if (resp.status === 429 && attempt < 4) continue;
}
```

### 5.4 图片缓存去重（解决客户端重复发送）

```javascript
const imageDescriptionCache = new Map();
const CACHE_TTL_MS = 60000;

function getCacheKey(images) {
  return crypto.createHash("md5").update(JSON.stringify(images)).digest("hex");
}

// 两层缓存检查：
// 1. handleChat 中请求进入时查缓存
// 2. doRecognizeImages 中队列弹出后、调 API 前再查一次
```

---

## 6. 工作经验与教训

### 🐛 Bug 1：历史图片累积发送

**症状**：每次发图，日志显示 "发送 2 张...3 张...4 张"，旧对话的图被反复识图。

**原因**：`extractImages` 遍历了所有消息，每次都把历史图片提取出来。

**修复**：改为从后往前遍历，只提取最新一条用户消息中的图片。

**教训**：处理数组时要明确"我需要全部还是最新的"，OpenAI 兼容协议的 messages 数组会累积整个对话历史。

### 🐛 Bug 2：纯文本消息也走识图

**症状**：不发图片时，回复也很慢，日志显示走了识图流程。

**原因**：`hasImages` 遍历所有消息，检测到历史消息中的图片格式就返回 true。

**修复**：改为只检测最新一条用户消息。

**教训**：逻辑判断不仅要看"是/否"，还要看"哪个范围"。

### 🐛 Bug 3：DeepSeek 报 400 错误

**症状**：`unknown variant 'image_url', expected 'text'`

**原因**：经过 injectDescription 处理后，消息中的 image_url 已转为文本，但**其他消息**（如 system 消息）中的 image_url 没有被清理。DeepSeek 是纯文本模型，不识别 image_url 格式。

**修复**：新增 `stripImages()` 函数，所有发往 DeepSeek 的消息都先清理掉 `image_url`。

**教训**：代理模式下，所有发往目标模型的数据都要**严格按**目标模型的能力范围来清洗。

### 🐛 Bug 4：WorkBuddy 重复发送同一图片

**症状**：日志显示 3-4 个独立 HTTP 请求（间隔 8-25 秒），每张图都被调了多次 GLM，GLM 免费额度被打满 429。

**原因**：WorkBuddy 客户端可能因为网络重试或 UI 交互发了多个请求。

**修复**：引入 60 秒图片缓存，同一张 base64 图片的识图结果缓存复用。

**教训**：当客户端不可控时，服务端要做防御性设计。

### 🐛 Bug 5：GLM-4.6V-Flash 频繁 429

**症状**：第一次测试时几乎每次调用都 429。

**原因**：短时间密集调用。

**修复**：队列串行化（1.5 秒间隔）+ 指数退避（4s/8s/16s/32s/64s）。

**教训**：免费模型很好，但要尊重它的限流策略。串行化请求比并行 + 重试更有效。

### 📋 实用技巧

1. **国内 npm 加速**：`npm config set registry https://registry.npmmirror.com`
2. **Docker 国内加速**：Dockerfile 中 `--registry=https://registry.npmmirror.com`
3. **Sealos 更新**：不需要删 Pod，**重启应用**即可拉取最新镜像
4. **日志查看**：在 Sealos 控制台开启 JSON 模式查看容器日志
5. **请求体限制**：图片 base64 很大，Express 需设 `app.use(express.json({ limit: "50mb" }))`

---

## 7. 故障排查手册

| 症状 | 可能原因 | 解决方法 |
|------|----------|----------|
| 日志无输出 | Pod 未重启新代码 | Sealos 重启应用 |
| GLM 返回 429 | 免费额度耗尽/并发过高 | 检查缓存是否生效，等待 1 分钟后重试 |
| DeepSeek 返回 400 | 消息中残留 image_url | 检查 `stripImages` 是否覆盖所有消息 |
| 回复速度慢 | 缓存未命中，正在调 GLM | 正常，同图第二次会很快（命中缓存） |
| 描述不准确 | GLM 识别能力有限 | 换更强大的视觉模型（如 qwen-vl-max） |
| 502 Bad Gateway | 代理崩溃或重启中 | 稍等片刻，查看 Sealos Pod 状态 |

---

> **总结**：DeepSeek 做大脑，GLM 做眼睛，Express 做桥梁。一个简单的代理架构，解决了"纯文本模型不能看图"的核心问题，同时通过队列、缓存、重试三层机制保证了稳定性。
