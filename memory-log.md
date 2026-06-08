# 2026-06-04

## DeepSeek 代理识图改造

### 问题
- 豆包视觉模型（doubao-seed-2-0-lite-260428）429 限流严重，即使低频调用也触发 burst protection
- 用户希望不固定单一视觉模型，多个模型轮询分摊免费额度

### 解决
1. **换视觉模型**: 豆包 → 通义千问 VL（qwen-vl-plus, qwen-vl-max）
   - 新 Key: `sk-1d405fc0a00845759a39d55621be96e2`（DashScope）
   - 新 URL: `https://dashscope.aliyuncs.com/compatible-mode/v1`
2. **多模型自动轮询**: `VISUAL_MODELS` 环境变量支持逗号分隔多个模型，round-robin 轮流使用
   - 向后兼容：如果只配 `VISUAL_MODEL`（单数）也能工作
3. **429 自动切模型**: 某个模型限流后标记冷却 60 秒，自动尝试下一个
4. **请求队列**: 视觉请求串行化排队，请求间 1.5s 间隔

### 切换为 GLM-4.6V-Flash（完全免费）
- 因 DashScope 无可用识图模型（全是生成/编辑类），切到智谱 GLM-4.6V-Flash
- 智谱 Key: `06e2b5ad5cf647d0aaae8d045cde9ccf.5M0Nq2Q1w5jxNELf`
- URL: `https://open.bigmodel.cn/api/paas/v4`
- GLM 免费但访问量大，429 限流较频繁（code 1305），有 5 次指数退避重试

### 修复的 Bug
1. **历史图片累积** — `extractImages` 遍历所有消息，每次对话都把旧图重新发送 → 改为只从最新用户消息提取
2. **无图也走识图** — `hasImages` 遍历所有消息，历史图片导致纯文本也识图 → 改为只检测最新消息
3. **DeepSeek 400 报错** — `image_url` 传给 DeepSeek（它不支持） → 新增 `stripImages`，所有发往 DeepSeek 的消息都先清理

### 部署
- GitHub Actions 自动构建镜像推送到 ghcr.io
- git push 后需更新 Sealos 环境变量并删除 Pod 重建
- 当前公网地址: `https://xzhymublbftq.sealoshzh.site`

### 新增：图片缓存去重（16:35）
- 问题：WorkBuddy 客户端同一张图发多次（日志显示 4 个独立请求，间隔 8-25 秒），每次都调 GLM 导致限流
- 方案：60 秒 TTL 的图片 MD5 缓存（`Map`），两层检查：handleChat 入口 + doRecognizeImages 队列弹出后
- commit: `b415a00`
- 用户重启 Sealos 应用后部署生效

### 文档总结（16:45）
- 编写了完整教程文档 `deepseek-vision-proxy-tutorial.md`
- 涵盖：命名定义、架构图、搭建步骤、核心代码解析、5 个 Bug 经验教训、故障排查手册
