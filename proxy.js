require("dotenv").config();

const express = require("express");
const app = express();

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

const VISUAL_KEY = process.env.VISUAL_API_KEY;
const VISUAL_URL = (process.env.VISUAL_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
const VISUAL_MODEL = process.env.VISUAL_MODEL || "qwen-vl-plus";

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
console.log(`  视觉模型:    ${VISUAL_URL} 模型: ${VISUAL_MODEL}`);
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

// ─── 调用视觉模型识图 ───
async function recognizeImages(images, userMessage = "") {
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

  console.log(`[视觉] 发送 ${images.length} 张图片到 ${VISUAL_MODEL}...`);

  const resp = await fetch(`${VISUAL_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VISUAL_KEY}`,
    },
    body: JSON.stringify({
      model: VISUAL_MODEL,
      messages,
      max_tokens: 2000,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`视觉模型调用失败 (${resp.status}): ${err}`);
  }

  const data = await resp.json();
  const description = data.choices?.[0]?.message?.content || "";
  console.log(`[视觉] 识图完成 (${description.length} 字符)`);
  return description;
}

// ─── 把识图结果注入消息（清理所有含图片的消息） ───
function injectDescription(messages, description) {
  return messages.map((msg) => {
    const content = msg.content;
    if (!Array.isArray(content)) return msg;

    return {
      ...msg,
      content: content
        .map((part) => {
          if (part.type === "image_url") {
            return { type: "text", text: `[图片描述: ${description}]` };
          }
          return part;
        })
        .filter((part) => part.type === "text"),
    };
  });
}

// ─── 流式转发到 DeepSeek ───
async function streamToDeepSeek(messages, res, reqStream) {
  const resp = await fetch(`${DEEPSEEK_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_KEY}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      stream: true,
    }),
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
async function callDeepSeek(messages) {
  const resp = await fetch(`${DEEPSEEK_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_KEY}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`DeepSeek 调用失败 (${resp.status}): ${err}`);
  }

  return resp.json();
}

// ─── 核心处理：识图 → DeepSeek ───
async function handleChat(req, res) {
  const { messages, stream } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "缺少 messages 参数" });
  }

  if (!hasImages(messages)) {
    console.log("[请求] 纯文本，直发 DeepSeek");
    if (stream) {
      return streamToDeepSeek(messages, res, stream);
    }
    const data = await callDeepSeek(messages);
    return res.json(data);
  }

  console.log("[请求] 检测到图片，先识图...");
  const images = extractImages(messages);

  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const userText = Array.isArray(lastUserMsg?.content)
    ? lastUserMsg.content.find((p) => p.type === "text")?.text || ""
    : lastUserMsg?.content || "";

  const description = await recognizeImages(images, userText);
  const newMessages = injectDescription(messages, description);

  console.log("[请求] 识图完成，转发到 DeepSeek");

  if (stream) {
    return streamToDeepSeek(newMessages, res, stream);
  }
  const data = await callDeepSeek(newMessages);
  return res.json(data);
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
