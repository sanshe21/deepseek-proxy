# DeepSeek 识图代理

> 给 DeepSeek 装上眼睛 —— DeepSeek（大脑）+ GLM-4.6V-Flash（免费眼睛）

让纯文本的 DeepSeek 也能看懂图片。不需要懂代码，30 分钟部署完成。

## 怎么工作的

```
你发图片 → 代理让 GLM 看图 → 图变成文字描述 → 传给 DeepSeek → 回复你
```

整个过程你感受不到，就像 DeepSeek 自己会看图一样。

## 一键部署

1. 打开 [Sealos](https://cloud.sealos.io)，注册登录
2. 创建应用，镜像填：`ghcr.io/sanshe21/deepseek-proxy:latest`
3. 端口填：`3001`
4. 配置以下环境变量：

| 变量 | 值 |
|------|-----|
| `DEEPSEEK_API_KEY` | 你的 DeepSeek Key（去 platform.deepseek.com 申请） |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | `deepseek-chat` |
| `VISUAL_API_KEY` | 你的智谱 Key（去 open.bigmodel.cn 申请，免费） |
| `VISUAL_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` |
| `VISUAL_MODEL` | `glm-4.6v-flash` |
| `PORT` | `3001` |

5. 点部署，等变成绿色 Running
6. 复制访问地址（类似 `https://xxxxx.sealoshzh.site`），在后面加 `/v1`
7. 配到 WorkBuddy 的自定义模型地址里

搞定了。

## 费用

- GLM-4.6V-Flash：**完全免费**
- DeepSeek：按量计费，非常便宜
- Sealos 服务器：新用户有免费额度，128M 内存几乎不花钱

## 更新代码

改完代码后：

```bash
git push
```

然后去 Sealos 点**重启**，自动拉取最新镜像。不需要重新部署。

## 项目结构

```
deepseek-proxy/
├── proxy.js       # 核心代理逻辑
├── Dockerfile     # 容器构建文件
├── package.json   # 项目依赖
├── .env.example   # 环境变量模板
├── .github/       # 自动打包配置
└── README.md      # 就这个
```

## 详细教程

小白也能看懂的完整教程见 [小白版手把手教程](./小白版手把手教程.md)，技术细节和 Bug 经验教训见 [技术文档](./技术文档.md)。

## 许可证

MIT
