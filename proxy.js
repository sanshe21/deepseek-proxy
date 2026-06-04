require("dotenv").config();

const express = require("express");
const app = express();

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

const VISUAL_KEY = process.env.VISUAL_API_KEY;
const VISUAL_URL = (process.env.VISUAL_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");

// 支持多个视觉模型，逗号分隔。优先读取 VISUAL_MODELS（复数），回退到 VISUAL_MODEL（单数）
const VISUAL_MODELS_RAW = process.env.VISUAL_MODELS || process.env.VISUAL_MODEL || "qwen3.7-plus";
const VISUAL_MODELS = VISUAL_MODELS_RAW.split(",").map(s => s.trim()).filter(Boolean);

// 多模型轮询状态
let visualModelIndex = 0;
const modelCooldowns = {}; // { modelName: timestamp } — 429 后的冷却到期时间
const MODEL_COOLDOWN_MS = 60 * 1000; // 冷却 60 秒

// ─── 轮询选模型：跳过冷却中的模型 ───
function pickNextVisualModel() {
  const now = Date.now();
  for (let attempt = 0; attempt < VISUAL_MODELS.length; attempt++) {
    const model = VISUAL_MODELS[visualModelIndex % VISUAL_MODELS.length];
    visualModelIndex = (visualModelIndex + 1) % VISUAL_MODELS.length;
    const cooldownUntil = modelCooldowns[model];
    if (!cooldownUntil || now >= cooldownUntil) {
      return model;
    }
    console.log(`  [轮询] 模型 ${model} 还在冷却中 (剩余 ${Math.round((cooldownUntil - now) / 1000)}s)，跳过`);
  }
  // 所有模型都在冷却中，返回第一个（硬走）
  console.log(`  [轮询] 所有模型都在冷却，硬走 ${VISUAL_MODELS[0]}`);
  return VISUAL_MODELS[0];
}

const PORT = process.env.PORT || 3001;

if (!DEEPSEEK_KEY) {
  console.error("[ERROR] 请在 .env 中设置 DEEPSEEK_API_KEY");
  process.exit(1);
}
if (!VISUAL_KEY) {
  console.error("[ERROR] 请在 .env 中设置 VISUAL_API_KEY");
  process.exit(1);
}

app.use(express.json({ limit: "50mb" }));

console.log("=".repeat(50));
console.log("DeepSeek 识图代理已启动");
console.log(`  端口:        ${PORT}`);
console.log(`  DeepSeek:    ${DEEPSEEK_URL} 模型: ${DEEPSEEK_MODEL}`);
console.log(`  视觉模型:    ${VISUAL_URL}`);
console.log(`  模型列表:    ${VISUAL_MODELS.join(", ")}  (轮询分摊额度)`);
console.log("=".repeat(50));

// ─── /v1/models ───
app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: [{ id: DEEPSEEK_MODEL, object: "model" }],
  });
});

// ─── 检测消息中是否包含图片 ───
function hasImages(messages) {
  return messages.some((msg) => {
    const content = msg.content;
    if (typeof content === "string") return false;
    if (Array.isArray(content)) {
      return content.some((part) => part.type === "image_url");
    }
    return false;
  });
}

// ─── 提取所有图片的 base64 ───
function extractImages(messages) {
  const images = [];
  for (const msg of messages) {
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type === "image_url") {
        images.push(part.image_url.url);
      }
    }
  }
  return images;
}

// ─── 视觉模型请求队列（串行化，防止 burst 限流） ───
const visualQueue = [];
let visualBusy = false;
let visualLastCallTime = 0;
const VISUAL_GAP_MS = 1500; // 请求间最小间隔

async function processVisualQueue() {
  if (visualBusy || visualQueue.length === 0) return;
  visualBusy = true;

  while (visualQueue.length > 0) {
    const { resolve, reject, params } = visualQueue.shift();

    // 确保与上次请求有足够间隔
    const now = Date.now();
    const sinceLast = now - visualLastCallTime;
    if (sinceLast < VISUAL_GAP_MS && visualLastCallTime > 0) {
      await new Promise((r) => setTimeout(r, VISUAL_GAP_MS - sinceLast));
    }

    try {
      const result = await doRecognizeImages(params.images, params.userMessage);
      visualLastCallTime = Date.now();
      resolve(result);
    } catch (err) {
      visualLastCallTime = Date.now();
      reject(err);
    }
  }

  visualBusy = false;
}

function enqueueVisualCall(images, userMessage) {
  return new Promise((resolve, reject) => {
    visualQueue.push({
      resolve,
      reject,
      params: { images, userMessage },
    });
    processVisualQueue();
  });
}

// ─── 实际调用视觉模型（429 自动切模型） ───
async function tryRecognizeWithModel(model, images, userMessage) {
  const imageContents = images.map((img) => ({
    type: "image_url",
    image_url: { url: img },
  }));

  const messages = [
    {
      role: "user",
      content: [
        ...imageContents,
        {
          type: "text",
          text: userMessage
            ? `请详细描述图片内容，用于后续回答问题。用户的问题是：${userMessage}`
            : "请详细描述这张图片里的所有内容，包括文字、物体、布局、颜色等。",
        },
      ],
    },
  ];

  console.log(`  [视觉] 尝试模型 ${model}，发送 ${images.length} 张图片...`);
  const resp = await fetch(`${VISUAL_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VISUAL_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 2000,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    return { ok: false, status: resp.status, error: errText };
  }

  const data = await resp.json();
  const description = data.choices?.[0]?.message?.content || "";
  return { ok: true, description };
}

async function doRecognizeImages(images, userMessage = "") {
  // 收集要尝试的模型顺序：先选一个，如果 429 就继续选下一个
  const triedModels = new Set();

  for (let attempt = 0; attempt < Math.max(VISUAL_MODELS.length, 3); attempt++) {
    const model = pickNextVisualModel();
    if (triedModels.has(model)) {
      // 如果所有模型都试过了还不行，等一会儿重试
      if (triedModels.size >= VISUAL_MODELS.length) {
        console.log(`  [视觉] 所有 ${VISUAL_MODELS.length} 个模型都试过了，等 10s 再试...`);
        await new Promise((r) => setTimeout(r, 10000));
        triedModels.clear();
        continue;
      }
      continue;
    }
    triedModels.add(model);

    const result = await tryRecognizeWithModel(model, images, userMessage);
    if (result.ok) {
      console.log(`  [视觉] 模型 ${model} 识图完成 (${result.description.length} 字符)`);
      return result.description;
    }

    if (result.status === 429) {
      modelCooldowns[model] = Date.now() + MODEL_COOLDOWN_MS;
      console.log(`  [视觉] 模型 ${model} 429 限流，冷却 60s，换下一个`);
      continue;
    }

    // 非 429 错误直接抛
    throw new Error(`视觉模型调用失败 (${result.status}): ${result.error}`);
  }

  throw new Error("视觉模型调用失败：所有模型限流，额度已用尽");
}

// ─── 把识图结果注入消息（只处理最新图片消息，清理历史图片） ───
function injectDescription(messages, description) {
  // 找到最新的一条包含图片的用户消息的索引
  let latestImageMsgIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      if (msg.content.some(p => p.type === "image_url")) {
        latestImageMsgIndex = i;
        break;
      }
    }
  }

  return messages.map((msg, idx) => {
    const content = msg.content;
    if (!Array.isArray(content)) return msg;

    // 检查这条消息是否包含图片
    const hasImage = content.some(p => p.type === "image_url");
    if (!hasImage) return msg;

    // 这是最新的一条图片消息：替换成问题描述 + 图片描述
    if (idx === latestImageMsgIndex) {
      const userText = content.find(p => p.type === "text")?.text || "";
      return {
        ...msg,
        content: [
          {
            type: "text",
            text: userText ? `${userText}\n\n[图片描述: ${description}]` : `[图片描述: ${description}]`,
          },
        ],
      };
    }

    // 这是历史中的图片消息：只保留文字部分，删除图片
    return {
      ...msg,
      content: content
        .filter(p => p.type === "text")
        .map(p => ({ type: "text", text: p.text })),
    };
  });
}

// ─── 流式转发到 DeepSeek ───
async function streamToDeepSeek(messages, res, originalBody) {
  // 构建转发给 DeepSeek 的请求体，透传所有参数
  const forwardBody = {
    model: DEEPSEEK_MODEL,
    messages,
    stream: true,
    ...originalBody, // 透传 temperature, max_tokens, top_p 等参数
  };
  // 确保 model 和 messages 不被覆盖
  forwardBody.model = DEEPSEEK_MODEL;
  forwardBody.messages = messages;
  forwardBody.stream = true;

  const resp = await fetch(`${DEEPSEEK_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_KEY}`,
    },
    body: JSON.stringify(forwardBody),
  });

  if (!resp.ok) {
    const err = await resp.text();
    res.status(resp.status).json({ error: `DeepSeek 调用失败: ${err}` });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } finally {
    res.end();
  }
}

// ─── 非流式转发到 DeepSeek ───
async function callDeepSeek(messages, originalBody) {
  // 构建转发给 DeepSeek 的请求体，透传所有参数
  const forwardBody = {
    model: DEEPSEEK_MODEL,
    messages,
    ...originalBody, // 透传 temperature, max_tokens, top_p 等参数
  };
  // 确保 model 和 messages 不被覆盖
  forwardBody.model = DEEPSEEK_MODEL;
  forwardBody.messages = messages;

  const resp = await fetch(`${DEEPSEEK_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_KEY}`,
    },
    body: JSON.stringify(forwardBody),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`DeepSeek 调用失败 (${resp.status}): ${err}`);
  }

  return resp.json();
}

// ─── 核心处理：识图 → DeepSeek ───
async function handleChat(req, res) {
  try {
    const { messages, stream, ...otherParams } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "缺少 messages 参数" });
    }

    if (!hasImages(messages)) {
      console.log("[请求] 纯文本，直发 DeepSeek");
      if (stream) {
        return streamToDeepSeek(messages, res, otherParams);
      }
      const data = await callDeepSeek(messages, otherParams);
      return res.json(data);
    }

    console.log("[请求] 检测到图片，先识图...");
    const images = extractImages(messages);

    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const userText = Array.isArray(lastUserMsg?.content)
      ? lastUserMsg.content.find((p) => p.type === "text")?.text || ""
      : lastUserMsg?.content || "";

    const description = await enqueueVisualCall(images, userText);
    const newMessages = injectDescription(messages, description);

    console.log("[请求] 识图完成，转发到 DeepSeek");

    if (stream) {
      return streamToDeepSeek(newMessages, res, otherParams);
    }
    const data = await callDeepSeek(newMessages, otherParams);
    return res.json(data);
  } catch (err) {
    console.error("[错误]", err.message);

    // 如果已经发送了响应头（流式模式中途出错），不再尝试返回 JSON
    if (res.headersSent) {
      return res.end();
    }
    res.status(500).json({ error: err.message });
  }
}

// WorkBuddy 可能把地址当成端点直接 POST，兼容多种路径
app.post("/v1/chat/completions", handleChat);
app.post("/v1", handleChat);
app.post("/", handleChat);

// ─── 健康检查 ───
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`代理服务运行在 http://localhost:${PORT}`);
  console.log("在 WorkBuddy 中配置自定义模型地址: http://localhost:3001/v1");
});
