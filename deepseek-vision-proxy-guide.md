# 小白也能懂的 DeepSeek 识图代理搭建教程

> 跟着做就行，不需要懂代码，30 分钟让你的 DeepSeek 能看图！

---

## 先搞清楚：这是干什么的？

DeepSeek 是个很能聊的 AI，但它**天生看不见图片**。这个教程就是给它装上一双免费的眼睛。

**逻辑很简单：**
你把图片发给 DeepSeek → 中间人先让另一个 AI 看一遍 → 把图里的内容写成文字 → 再把文字传给 DeepSeek → DeepSeek 看完文字回答你。

整个过程你感受不到，就像 DeepSeek 自己看图一样。

---

## 你需要准备这几样东西

### 1. 一个 GitHub 账号
去 [github.com](https://github.com) 免费注册一个，记住用户名和密码。

### 2. DeepSeek 的 API 密钥
去 [platform.deepseek.com](https://platform.deepseek.com) 注册，找到 "API Keys" 创建一个。密钥长这样：
```
sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```
**记下来，后面要用。**

### 3. 智谱（GLM）的 API 密钥
去 [open.bigmodel.cn](https://open.bigmodel.cn) 注册，这是国内公司，全中文界面。进去后找 "API Keys" 创建一个。密钥类似这样：
```
xxxxxxxx.xxxxxxxxxxxx
```
**也记下来，后面要用。这个是免费看图用的。**

### 4. Sealos 云平台账号
去 [sealos.io](https://sealos.io) 注册，选择国内区（杭州节点）。注册就能用，不用绑卡。

---

## 正式开始：分 7 步走

### 第 1 步：在 GitHub 上创建项目

1. 打开浏览器，登录 GitHub
2. 点右上角头像左边的 **"+"** 号，选 **"New repository"**
3. 仓库名字填：`deepseek-proxy`（小写英文，不能有空格）
4. 下面选 **"Private"**（私有，别人看不见）
5. 其他什么都不用改，直接点底部的绿色 **"Create repository"** 按钮

创建完成后你会看到一个空的项目页面，上面有几行命令，先别关。

### 第 2 步：下载代码到电脑上

打开你电脑的命令行工具：
- Windows：按 `Win + R`，输入 `cmd`，回车
- Mac：打开 "终端"（Terminal）

**重要：以下命令不要全部一起粘贴，一条一条来！**

**先装必要的东西：**

```bash
# 装 git（代码管理工具）
# Windows: 去 https://git-scm.com 下载安装
# Mac: 命令行输入 git --version，没装的话会提示你装

# 装 node.js（运行代码的环境）
# 去 https://nodejs.org 下载左边那个（LTS版本）
# 下载后一路点"下一步"安装就行
```

**然后创建项目文件夹：**

```bash
# 在电脑上建一个项目文件夹
mkdir deepseek-proxy
cd deepseek-proxy
```

### 第 3 步：把代码写进去

在命令行里，一条一条复制粘贴下面这些命令：

```bash
# 初始化项目
npm init -y
npm install express dotenv
```

然后创建一个新文件叫 `proxy.js`，把下面这段代码完整复制进去（在项目文件夹里新建一个文本文件，粘贴进去后改名为 `proxy.js`）：

> 代码太长这里不贴，从项目仓库 `proxy.js` 里完整复制过来就行。

再同样方法，在同一个文件夹里创建 `Dockerfile` 文件，粘贴下面内容：

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --registry=https://registry.npmmirror.com
COPY . .
EXPOSE 3001
CMD ["node", "proxy.js"]
```

再创建一个 `.env` 文件，把自己真实的密钥填进去（注意替换掉示例值）：

```
DEEPSEEK_API_KEY=sk-把你自己的deepseek密钥粘在这里
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
VISUAL_API_KEY=把你自己的智谱密钥粘在这里
VISUAL_BASE_URL=https://open.bigmodel.cn/api/paas/v4
VISUAL_MODEL=glm-4.6v-flash
PORT=3001
```

再创建一个 `.gitignore` 文件，写一行：
```
.env
```

### 第 4 步：创建自动部署配置

在你的项目文件夹里，新建 `.github` 文件夹，再在里面建 `workflows` 文件夹，然后在里面创建一个 `build.yml` 文件，粘贴下面内容：

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
      - name: Checkout
        uses: actions/checkout@v4
      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Build and Push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ghcr.io/${{ github.repository }}:latest
```

### 第 5 步：把代码上传到 GitHub

在命令行里，继续输入以下命令（同样一条一条来）：

```bash
git init
git add .
git commit -m "第一次提交"
git branch -M master
git remote add origin https://github.com/你的用户名/deepseek-proxy.git
git push -u origin master
```

> 注意：最后一行里 "你的用户名" 要换成你自己的 GitHub 用户名。
> 推送时如果让你输账号密码，输入 GitHub 用户名和密码就行。

推送成功后，去 GitHub 的项目页面刷新一下，应该能看到所有文件了。

**然后点 "Actions" 标签**，你会看到一个正在运行的黄色圆圈，它在自动打包你的项目。等它变绿✅，就说明打包成功了。

### 第 6 步：在 Sealos 上部署

1. 登录 [Sealos 控制台](https://cloud.sealos.io)
2. 左边菜单点**"应用管理"**
3. 点右上角**"新建应用"**
4. 填写信息：

| 这一项 | 填什么 |
|--------|--------|
| 应用名称 | `deepseek-proxy` |
| 镜像 | `ghcr.io/你的用户名/deepseek-proxy:latest` |

5. 往下找到**"端口"**，点添加，填 `3001`

6. 再往下找到**"环境变量"**，一个一个添加。每点一次"添加"，就填一对键和值：

| 键（Key） | 值（Value） |
|-----------|-------------|
| `DEEPSEEK_API_KEY` | 你的 DeepSeek 密钥（sk-xxxx） |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | `deepseek-chat` |
| `VISUAL_API_KEY` | 你的智谱密钥（xxxx.xxxx） |
| `VISUAL_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` |
| `VISUAL_MODEL` | `glm-4.6v-flash` |
| `PORT` | `3001` |

7. 底部资源限制不用改，直接点**"部署"**按钮。

等几十秒，状态变成**绿色 Running**，就成功了！

8. 部署成功后，**点击这个应用**，找到**"访问地址"**，把它复制下来。类似这样：
```
https://xxxxx.sealoshzh.site
```

### 第 7 步：配到你的 AI 工具里

在 WorkBuddy（或任何支持自定义接口的 AI 工具）的设置里：

- 找到**"自定义模型"**或**"API 地址"**
- 填入：`https://xxxxx.sealoshzh.site/v1`
- API Key 填你的 DeepSeek 密钥
- 保存

搞定了！现在你发图片给 DeepSeek，它就能"看见"了。

---

## 以后怎么更新代码

代码改完了要生效，只需要两步：

1. **在命令行里**：
```bash
cd deepseek-proxy
git add .
git commit -m "改了什么写在这里"
git push
```

2. **去 Sealos 控制台**，找到 `deepseek-proxy` 这个应用，点**"重启"**就行。它会自动用你最新的代码。

---

## 走不通怎么办？

| 你遇到的 | 大概率是 |
|----------|----------|
| `git push` 报错 | 账号密码没输对，或者仓库地址写错了 |
| GitHub Actions 红色❌ | 点进去看报错信息，大概率是代码有个地方复制错了 |
| Sealos 部署后一直灰色 | 镜像名称写错了，检查一下 "ghcr.io/你的用户名/deepseek-proxy:latest" |
| 发了图但回复说看不到 | 检查 DeepSeek_API_KEY 有没有填对，有没有复制全 |
| 回复很慢或者报错 | 智谱的免费额度可能用完了，等几分钟再试 |
| 收到 502 错误 | 应用可能挂了，去 Sealos 点"重启" |

---

## 你花了多少钱？

### API 费用

| 是谁的 | 要不要钱 |
|--------|----------|
| GLM-4.6V-Flash（看图） | **免费** ✅ |
| DeepSeek（聊天） | 按量收费，但非常便宜，对话 100 次大概几分钱 |

### 服务器费用

Sealos 给新用户送了免费额度，这个小应用 128M 内存就能跑，前几个月基本不花钱。如果没什么人用，半年可能都花不了 10 块钱。

---

## 常见问题

### 换台电脑还能用吗？

能用。服务跑在 Sealos 云端，跟你的电脑无关。换台新电脑，只需要把 `https://xxxxx.sealoshzh.site/v1` 这个地址配进去就行。

### 能把地址分享给别人用吗？

可以。发给他地址，他在自己的 AI 工具里配置就行。多个设备同时用也不会冲突，就像微信能同时在手机和电脑登录一样。

### 别人用会花我的钱吗？

会的。因为 Key 是你配的，别人用的其实是你的 API 额度。给朋友体验一下没问题，但如果群发上百人，建议让他们自己申请 Key、自己部署。

### 部署完还能改代码吗？

可以。改完代码后 `git push`，然后去 Sealos 点**重启**，新功能就生效了。不用重新部署。

---

## 结尾

就这么简单。你做了一个"中间人"代理，它帮你在图和 AI 之间自动翻译，整个过程你完全感受不到。

如果有人问你：你的 DeepSeek 怎么能看图了？你可以说：**我用 GLM-4.6V 给它装的。**
