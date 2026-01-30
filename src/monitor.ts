import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";

import type { ClawdbotConfig, PluginRuntime } from "clawdbot/plugin-sdk";

import type {
  ResolvedWecomAccount,
  WecomInboundMessage,
  WecomInboundText,
  WecomInboundVoice,
  WecomInboundMixed,
  WecomInboundMixedItem,
  WecomInboundImage,
  WecomInboundFile,
  WecomInboundEvent,
  WecomInboundStreamRefresh,
} from "./types.js";
import { decryptWecomEncrypted, encryptWecomPlaintext, verifyWecomSignature, computeWecomMsgSignature } from "./crypto.js";
import { getWecomRuntime } from "./runtime.js";
import { downloadImageFromUrl } from "./wecom-api.js";
import { sendTextMessage, sendImageMessage, sendFileMessage, uploadMedia } from "./api.js";

export type WecomRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

type WecomWebhookTarget = {
  account: ResolvedWecomAccount;
  config: ClawdbotConfig;
  runtime: WecomRuntimeEnv;
  core: PluginRuntime;
  path: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

type StreamImage = {
  base64: string;
  md5: string;
};

type StreamState = {
  streamId: string;
  msgid?: string;
  createdAt: number;
  updatedAt: number;
  lastRefreshAt: number; // 最后一次被企业微信刷新的时间
  started: boolean;
  finished: boolean;
  error?: string;
  content: string;
  images: StreamImage[]; // 图片列表，最多10张
  // 主动消息补发相关
  proactiveSent: boolean; // 是否已通过主动消息发送
  target?: string; // 用户ID 或群聊ID
  isGroup?: boolean; // 是否群聊
  account?: ResolvedWecomAccount; // 用于主动发送的账号配置
};

const webhookTargets = new Map<string, WecomWebhookTarget[]>();
const streams = new Map<string, StreamState>();
const msgidToStreamId = new Map<string, string>();

const STREAM_TTL_MS = 10 * 60 * 1000;
const STREAM_MAX_BYTES = 20_480;
// 企业微信 stream 模式超时时间：如果 60 秒内没有刷新请求，认为已超时
const STREAM_REFRESH_TIMEOUT_MS = 60 * 1000;

function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) return withSlash.slice(0, -1);
  return withSlash;
}

function pruneStreams(log?: (message: string) => void): void {
  const cutoff = Date.now() - STREAM_TTL_MS;
  for (const [id, state] of streams.entries()) {
    if (state.updatedAt < cutoff) {
      streams.delete(id);
    }
  }
  for (const [msgid, id] of msgidToStreamId.entries()) {
    if (!streams.has(id)) {
      msgidToStreamId.delete(msgid);
    }
  }
  // 检查超时补发
  checkAndSendProactiveMessages(log).catch(() => {});
}

function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const slice = buf.subarray(buf.length - maxBytes);
  return slice.toString("utf8");
}

// 图片 URL 最大大小：10MB
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

// 匹配文本中的图片 URL（支持 markdown 格式和纯 URL）
const IMAGE_URL_PATTERNS = [
  /!\[.*?\]\((https?:\/\/[^\s)]+\.(?:png|jpg|jpeg|gif|webp)(?:\?[^\s)]*)?)\)/gi, // ![alt](url)
  /(?<!\()(https?:\/\/[^\s<>"']+\.(?:png|jpg|jpeg|gif|webp)(?:\?[^\s<>"']*)?)(?!\))/gi, // 纯 URL
];


// 匹配文件 URL（非图片）
const FILE_URL_PATTERNS = [
  /(?<!\()(https?:\/\/[^\s<>"']+\.(?:pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|7z|tar|gz|txt|csv|mp3|mp4|avi|mov|wmv)(?:\?[^\s<>"']*)?)(?!\))/gi,
];

/**
 * 从文本中提取图片 URL
 */
function extractImageUrls(text: string): string[] {
  const urls = new Set<string>();
  for (const pattern of IMAGE_URL_PATTERNS) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const url = match[1] || match[0];
      if (url) urls.add(url);
    }
  }
  return Array.from(urls);
}

/**
 * 下载图片并转换为 base64
 */
async function downloadImageAsBase64(url: string): Promise<StreamImage | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30秒超时

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ClawdbotWecom/1.0)",
      },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return null;
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    // 检查大小限制
    if (buffer.length > MAX_IMAGE_SIZE) {
      return null;
    }

    const base64 = buffer.toString("base64");
    const md5 = crypto.createHash("md5").update(buffer).digest("hex");

    return { base64, md5 };
  } catch {
    return null;
  }
}

/**
 * 从 data URL 提取 base64 图片
 * 使用更稳健的方式处理各种格式的 base64 数据
 */
function extractDataUrlImages(text: string): { dataUrls: string[]; base64List: StreamImage[] } {
  const dataUrls: string[] = [];
  const base64List: StreamImage[] = [];

  // 查找所有 data:image 的起始位置
  const prefix = "data:image/";
  let searchStart = 0;

  while (true) {
    const idx = text.indexOf(prefix, searchStart);
    if (idx === -1) break;

    // 找到 base64, 的位置
    const base64Marker = ";base64,";
    const markerIdx = text.indexOf(base64Marker, idx);
    if (markerIdx === -1 || markerIdx > idx + 30) {
      // 不是有效的 data URL 格式
      searchStart = idx + 1;
      continue;
    }

    const dataStart = markerIdx + base64Marker.length;

    // 从 dataStart 开始，收集所有有效的 base64 字符
    // 有效字符：A-Z, a-z, 0-9, +, /, =, 以及空白（换行、空格）
    let dataEnd = dataStart;
    while (dataEnd < text.length) {
      const char = text[dataEnd];
      if (/[A-Za-z0-9+/=\s]/.test(char)) {
        dataEnd++;
      } else {
        break;
      }
    }

    const fullMatch = text.slice(idx, dataEnd);
    const base64WithSpaces = text.slice(dataStart, dataEnd);
    const base64Data = base64WithSpaces.replace(/\s/g, "");

    console.log(`[wecom-debug] found data URL at idx=${idx}, base64 raw length=${base64WithSpaces.length}, cleaned length=${base64Data.length}`);

    if (base64Data && base64Data.length > 100) {
      try {
        const buffer = Buffer.from(base64Data, "base64");
        // 检查是否是有效的图片数据（PNG/JPEG/GIF/WebP 魔数）
        const isValidImage = buffer.length > 8 && (
          // PNG: 89 50 4E 47
          (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) ||
          // JPEG: FF D8 FF
          (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) ||
          // GIF: 47 49 46 38
          (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) ||
          // WebP: 52 49 46 46 ... 57 45 42 50
          (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46)
        );

        if (isValidImage && buffer.length <= MAX_IMAGE_SIZE) {
          const md5 = crypto.createHash("md5").update(buffer).digest("hex");
          dataUrls.push(fullMatch);
          base64List.push({ base64: base64Data, md5 });
          console.log(`[wecom-debug] valid image extracted, size=${buffer.length} bytes, md5=${md5.slice(0, 8)}`);
        } else {
          console.log(`[wecom-debug] invalid image data: isValidImage=${isValidImage}, size=${buffer.length}`);
        }
      } catch (err) {
        console.log(`[wecom-debug] base64 decode error: ${String(err)}`);
      }
    }

    searchStart = dataEnd;
  }

  return { dataUrls, base64List };
}

/**
 * 处理文本中的图片，下载并转换为 StreamImage
 * 支持 URL 和 data URL 两种格式
 * 返回处理后的文本（移除图片）和图片列表
 */
async function processImagesInText(text: string): Promise<{ text: string; images: StreamImage[] }> {
  const images: StreamImage[] = [];
  let processedText = text;

  // 1. 先处理 data URL 格式的图片（无需下载）
  const hasDataImageText = text.includes("data:image");
  const { dataUrls, base64List } = extractDataUrlImages(text);
  // 调试：如果文本包含 data:image 但没提取到，说明正则有问题
  if (hasDataImageText && dataUrls.length === 0) {
    console.log(`[wecom-debug] WARNING: text contains 'data:image' but extractDataUrlImages found 0 matches`);
    // 找到 data:image 的位置并显示周围内容
    const idx = text.indexOf("data:image");
    console.log(`[wecom-debug] context around 'data:image': ...${text.slice(Math.max(0, idx - 20), idx + 100)}...`);
  }
  if (hasDataImageText) {
    console.log(`[wecom-debug] text contains 'data:image', extracted ${dataUrls.length} images`);
  }
  for (let i = 0; i < dataUrls.length && images.length < 10; i++) {
    images.push(base64List[i]);
    processedText = processedText.replace(dataUrls[i], "");
    console.log(`[wecom-debug] extracted data URL image #${i + 1}, base64 length: ${base64List[i].base64.length}`);
  }

  // 2. 再处理需要下载的 URL 图片
  const urls = extractImageUrls(processedText);
  if (urls.length > 0 && images.length < 10) {
    const remainingSlots = 10 - images.length;
    const downloadPromises = urls.slice(0, remainingSlots).map((url) => downloadImageAsBase64(url));
    const results = await Promise.all(downloadPromises);

    for (let i = 0; i < urls.length && i < remainingSlots; i++) {
      const img = results[i];
      if (img) {
        images.push(img);
        // 从文本中移除已处理的图片 URL（包括 markdown 格式）
        const url = urls[i];
        processedText = processedText
          .replace(new RegExp(`!\\[.*?\\]\\(${escapeRegExp(url)}\\)`, "g"), "")
          .replace(new RegExp(escapeRegExp(url), "g"), "");
      }
    }
  }

  // 清理多余的空行
  processedText = processedText.replace(/\n{3,}/g, "\n\n").trim();

  return { text: processedText, images };
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 从文本中提取文件 URL
 */
function extractFileUrls(text: string): string[] {
  const urls = new Set<string>();
  for (const pattern of FILE_URL_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const url = match[1] || match[0];
      if (url) urls.add(url);
    }
  }
  return Array.from(urls);
}

/**
 * 下载文件并返回 Buffer
 */
async function downloadFile(url: string): Promise<{ buffer: Buffer; filename: string; contentType: string } | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000); // 60秒超时

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ClawdbotWecom/1.0)",
      },
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await res.arrayBuffer());

    // 从 URL 或 Content-Disposition 提取文件名
    let filename = "file";
    const disposition = res.headers.get("content-disposition");
    if (disposition) {
      const match = disposition.match(/filename[^;=\n]*=(['"]?)([^'"\n;]*)\1/i);
      if (match?.[2]) filename = match[2];
    } else {
      const urlPath = new URL(url).pathname;
      const lastSegment = urlPath.split("/").pop();
      if (lastSegment && lastSegment.includes(".")) filename = lastSegment;
    }

    return { buffer, filename, contentType };
  } catch {
    return null;
  }
}

/**
 * 通过主动消息 API 发送内容（超时补发）
 */
async function sendProactiveMessage(params: {
  account: ResolvedWecomAccount;
  target: string;
  isGroup: boolean;
  content: string;
  images: StreamImage[];
  log?: (message: string) => void;
}): Promise<boolean> {
  const { account, target, isGroup, content, images, log } = params;

  if (!account.outboundConfigured) {
    log?.(`[wecom] 未配置出站 API，无法发送主动消息`);
    return false;
  }

  try {
    // 1. 发送文本内容
    if (content.trim()) {
      const textResult = await sendTextMessage({
        account,
        target,
        text: content,
        isGroup,
      });
      if (textResult.errcode !== 0) {
        log?.(`[wecom] 主动发送文本失败: ${textResult.errcode} ${textResult.errmsg}`);
      } else {
        log?.(`[wecom] 主动发送文本成功`);
      }
    }

    // 2. 发送图片
    for (const img of images) {
      try {
        const buffer = Buffer.from(img.base64, "base64");
        const mediaId = await uploadMedia({
          account,
          type: "image",
          buffer,
          filename: `image_${img.md5.slice(0, 8)}.png`,
        });
        const imgResult = await sendImageMessage({
          account,
          target,
          mediaId,
          isGroup,
        });
        if (imgResult.errcode !== 0) {
          log?.(`[wecom] 主动发送图片失败: ${imgResult.errcode} ${imgResult.errmsg}`);
        } else {
          log?.(`[wecom] 主动发送图片成功`);
        }
      } catch (err) {
        log?.(`[wecom] 主动发送图片异常: ${String(err)}`);
      }
    }

    // 3. 检测并发送文件 URL
    const fileUrls = extractFileUrls(content);
    for (const fileUrl of fileUrls) {
      try {
        log?.(`[wecom] 检测到文件 URL，尝试下载: ${fileUrl}`);
        const fileData = await downloadFile(fileUrl);
        if (fileData) {
          const mediaId = await uploadMedia({
            account,
            type: "file",
            buffer: fileData.buffer,
            filename: fileData.filename,
            contentType: fileData.contentType,
          });
          const fileResult = await sendFileMessage({
            account,
            target,
            mediaId,
            isGroup,
          });
          if (fileResult.errcode !== 0) {
            log?.(`[wecom] 主动发送文件失败: ${fileResult.errcode} ${fileResult.errmsg}`);
          } else {
            log?.(`[wecom] 主动发送文件成功: ${fileData.filename}`);
          }
        } else {
          log?.(`[wecom] 文件下载失败: ${fileUrl}`);
        }
      } catch (err) {
        log?.(`[wecom] 主动发送文件异常: ${String(err)}`);
      }
    }

    return true;
  } catch (err) {
    log?.(`[wecom] 主动发送消息异常: ${String(err)}`);
    return false;
  }
}

/**
 * 检查超时的 stream 并使用主动消息补发
 */
async function checkAndSendProactiveMessages(log?: (message: string) => void): Promise<void> {
  const now = Date.now();
  for (const [streamId, state] of streams.entries()) {
    // 跳过已完成、已发送主动消息、或没有配置出站 API 的
    if (state.proactiveSent || !state.account?.outboundConfigured || !state.target) {
      continue;
    }

    // 检查是否超时：已开始处理、未完成、且超过刷新超时时间
    const timeSinceLastRefresh = now - state.lastRefreshAt;
    if (state.started && !state.finished && timeSinceLastRefresh > STREAM_REFRESH_TIMEOUT_MS) {
      log?.(`[wecom] stream ${streamId} 刷新超时 (${Math.round(timeSinceLastRefresh / 1000)}s)，等待完成后发送主动消息...`);
      // 标记已发送，避免重复
      state.proactiveSent = true;

      // 等待处理完成（最多再等 5 分钟）
      const waitStart = Date.now();
      while (!state.finished && Date.now() - waitStart < 5 * 60 * 1000) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      if (state.content.trim() || state.images.length > 0) {
        log?.(`[wecom] stream ${streamId} 开始主动消息补发`);
        await sendProactiveMessage({
          account: state.account,
          target: state.target,
          isGroup: state.isGroup ?? false,
          content: state.content,
          images: state.images,
          log,
        });
      }
    }
  }
}

function jsonOk(res: ServerResponse, body: unknown): void {
  res.statusCode = 200;
  // WeCom's reference implementation returns the encrypted JSON as text/plain.
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({ ok: false, error: "empty payload" });
          return;
        }
        resolve({ ok: true, value: JSON.parse(raw) as unknown });
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

function buildEncryptedJsonReply(params: {
  account: ResolvedWecomAccount;
  plaintextJson: unknown;
  nonce: string;
  timestamp: string;
}): { encrypt: string; msgsignature: string; timestamp: string; nonce: string } {
  const plaintext = JSON.stringify(params.plaintextJson ?? {});
  const encrypt = encryptWecomPlaintext({
    encodingAESKey: params.account.encodingAESKey ?? "",
    receiveId: params.account.receiveId ?? "",
    plaintext,
  });
  const msgsignature = computeWecomMsgSignature({
    token: params.account.token ?? "",
    timestamp: params.timestamp,
    nonce: params.nonce,
    encrypt,
  });
  return {
    encrypt,
    msgsignature,
    timestamp: params.timestamp,
    nonce: params.nonce,
  };
}

function resolveQueryParams(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams;
}

function resolvePath(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", "http://localhost");
  return normalizeWebhookPath(url.pathname || "/");
}

function resolveSignatureParam(params: URLSearchParams): string {
  return (
    params.get("msg_signature") ??
    params.get("msgsignature") ??
    params.get("signature") ??
    ""
  );
}

function buildStreamPlaceholderReply(streamId: string): { msgtype: "stream"; stream: { id: string; finish: boolean; content: string } } {
  return {
    msgtype: "stream",
    stream: {
      id: streamId,
      finish: false,
      // Spec: "第一次回复内容为 1" works as a minimal placeholder.
      content: "收到请稍后~",
    },
  };
}

type StreamReplyMsgItem = {
  msgtype: "image";
  image: { base64: string; md5: string };
};

type StreamReply = {
  msgtype: "stream";
  stream: {
    id: string;
    finish: boolean;
    content: string;
    msg_item?: StreamReplyMsgItem[];
  };
};

function buildStreamReplyFromState(state: StreamState): StreamReply {
  const content = truncateUtf8Bytes(state.content, STREAM_MAX_BYTES);
  const reply: StreamReply = {
    msgtype: "stream",
    stream: {
      id: state.streamId,
      finish: state.finished,
      content,
    },
  };

  // 只有在 finish=true 时才能发送图片
  if (state.finished && state.images.length > 0) {
    reply.stream.msg_item = state.images.slice(0, 10).map((img) => ({
      msgtype: "image" as const,
      image: { base64: img.base64, md5: img.md5 },
    }));
  }

  return reply;
}

function createStreamId(): string {
  return crypto.randomBytes(16).toString("hex");
}

function logVerbose(target: WecomWebhookTarget, message: string): void {
  const core = target.core;
  const should = core.logging?.shouldLogVerbose?.() ?? false;
  if (should) {
    target.runtime.log?.(`[wecom] ${message}`);
  }
}

function parseWecomPlainMessage(raw: string): WecomInboundMessage {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  return parsed as WecomInboundMessage;
}

async function waitForStreamContent(streamId: string, maxWaitMs: number): Promise<void> {
  if (maxWaitMs <= 0) return;
  const startedAt = Date.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      const state = streams.get(streamId);
      if (!state) return resolve();
      if (state.error || state.finished || state.content.trim()) return resolve();
      if (Date.now() - startedAt >= maxWaitMs) return resolve();
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function startAgentForStream(params: {
  target: WecomWebhookTarget;
  accountId: string;
  msg: WecomInboundMessage;
  streamId: string;
}): Promise<void> {
  const { target, msg, streamId } = params;
  const core = target.core;
  const config = target.config;
  const account = target.account;

  const userid = msg.from?.userid?.trim() || "unknown";
  const chatType = msg.chattype === "group" ? "group" : "direct";
  const chatId = msg.chattype === "group" ? (msg.chatid?.trim() || "unknown") : userid;

  // 使用异步函数处理图片下载
  const rawBody = await buildInboundBodyWithImages(msg, target.runtime.log);

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
    peer: { kind: chatType === "group" ? "group" : "dm", id: chatId },
  });

  logVerbose(target, `starting agent processing (streamId=${streamId}, agentId=${route.agentId}, peerKind=${chatType}, peerId=${chatId})`);

  const fromLabel = chatType === "group" ? `group:${chatId}` : `user:${userid}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "WeCom",
    from: fromLabel,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: chatType === "group" ? `wecom:group:${chatId}` : `wecom:${userid}`,
    To: `wecom:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    SenderName: userid,
    SenderId: userid,
    Provider: "wecom",
    Surface: "wecom",
    MessageSid: msg.msgid,
    OriginatingChannel: "wecom",
    OriginatingTo: `wecom:${chatId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      target.runtime.error?.(`wecom: failed updating session meta: ${String(err)}`);
    },
  });

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload) => {
        const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
        const current = streams.get(streamId);
        if (!current) return;
        const nextText = current.content
          ? `${current.content}\n\n${text}`.trim()
          : text.trim();
        current.content = truncateUtf8Bytes(nextText, STREAM_MAX_BYTES);
        current.updatedAt = Date.now();
        target.statusSink?.({ lastOutboundAt: Date.now() });
      },
      onError: (err, info) => {
        target.runtime.error?.(`[${account.accountId}] wecom ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });

  const current = streams.get(streamId);
  if (current) {
    // 在结束前处理文本中的图片
    try {
      // 调试日志：输出原始内容
      target.runtime.log?.(`[wecom] processing content for images, length=${current.content.length}`);
      const urls = extractImageUrls(current.content);
      target.runtime.log?.(`[wecom] found ${urls.length} image URLs: ${urls.slice(0, 3).join(', ')}${urls.length > 3 ? '...' : ''}`);

      const { text: processedText, images } = await processImagesInText(current.content);
      if (images.length > 0) {
        current.content = processedText;
        current.images = images;
        target.runtime.log?.(`[wecom] processed ${images.length} images from response`);
      }
    } catch (err) {
      target.runtime.error?.(`[${account.accountId}] wecom image processing failed: ${String(err)}`);
    }
    current.finished = true;
    current.updatedAt = Date.now();
  }
}

function buildInboundBody(msg: WecomInboundMessage): string {
  const msgtype = String(msg.msgtype ?? "").toLowerCase();
  if (msgtype === "text") {
    const content = (msg as WecomInboundText).text?.content;
    return typeof content === "string" ? content : "";
  }
  if (msgtype === "voice") {
    const content = (msg as WecomInboundVoice).voice?.content;
    return typeof content === "string" ? content : "[voice]";
  }
  if (msgtype === "mixed") {
    const items = (msg as WecomInboundMixed).mixed?.msg_item;
    if (Array.isArray(items)) {
      return items
        .map((item: WecomInboundMixedItem) => {
          const t = String(item?.msgtype ?? "").toLowerCase();
          if (t === "text") return String(item?.text?.content ?? "");
          if (t === "image") return `[image] ${String(item?.image?.url ?? "").trim()}`.trim();
          return `[${t || "item"}]`;
        })
        .filter((part: string) => Boolean(part && part.trim()))
        .join("\n");
    }
    return "[mixed]";
  }
  if (msgtype === "image") {
    const url = String((msg as WecomInboundImage).image?.url ?? "").trim();
    return url ? `[image] ${url}` : "[image]";
  }
  if (msgtype === "file") {
    const url = String((msg as WecomInboundFile).file?.url ?? "").trim();
    return url ? `[file] ${url}` : "[file]";
  }
  if (msgtype === "event") {
    const eventtype = String((msg as WecomInboundEvent).event?.eventtype ?? "").trim();
    return eventtype ? `[event] ${eventtype}` : "[event]";
  }
  if (msgtype === "stream") {
    const id = String((msg as WecomInboundStreamRefresh).stream?.id ?? "").trim();
    return id ? `[stream_refresh] ${id}` : "[stream_refresh]";
  }
  return msgtype ? `[${msgtype}]` : "";
}

/**
 * 从图片 URL 下载图片并转换为 data URL
 */
async function downloadAndConvertToDataUrl(
  imageUrl: string,
  log?: (message: string) => void,
): Promise<string | null> {
  try {
    const result = await downloadImageFromUrl(imageUrl);
    if (!result) {
      log?.(`[wecom] 无法下载图片: ${imageUrl}`);
      return null;
    }

    // 根据 contentType 确定图片格式
    let mimeType = result.contentType;
    if (!mimeType.startsWith("image/")) {
      mimeType = "image/png"; // 默认使用 PNG
    }

    // 构建 data URL
    const dataUrl = `data:${mimeType};base64,${result.base64}`;
    log?.(`[wecom] 图片下载成功: ${imageUrl.slice(0, 50)}... -> data URL (${result.buffer.length} bytes)`);
    return dataUrl;
  } catch (err) {
    log?.(`[wecom] 图片下载失败: ${imageUrl} - ${String(err)}`);
    return null;
  }
}

/**
 * 异步构建入站消息体，处理图片下载
 */
async function buildInboundBodyWithImages(
  msg: WecomInboundMessage,
  log?: (message: string) => void,
): Promise<string> {
  const msgtype = String(msg.msgtype ?? "").toLowerCase();

  // 处理图片消息
  if (msgtype === "image") {
    const url = String((msg as WecomInboundImage).image?.url ?? "").trim();
    if (url) {
      log?.(`[wecom] 收到图片消息，尝试下载: ${url.slice(0, 80)}...`);
      const dataUrl = await downloadAndConvertToDataUrl(url, log);
      if (dataUrl) {
        // 返回 data URL，AI 可以识别
        return `[用户发送了一张图片]\n${dataUrl}`;
      }
      // 下载失败，返回原始 URL
      return `[用户发送了一张图片，但下载失败]\n原始链接: ${url}`;
    }
    return "[image]";
  }

  // 处理混合消息（图文混合）
  if (msgtype === "mixed") {
    const items = (msg as WecomInboundMixed).mixed?.msg_item;
    if (Array.isArray(items)) {
      const parts: string[] = [];
      for (const item of items) {
        const t = String(item?.msgtype ?? "").toLowerCase();
        if (t === "text") {
          const content = String(item?.text?.content ?? "").trim();
          if (content) parts.push(content);
        } else if (t === "image") {
          const url = String(item?.image?.url ?? "").trim();
          if (url) {
            log?.(`[wecom] 混合消息中收到图片，尝试下载: ${url.slice(0, 80)}...`);
            const dataUrl = await downloadAndConvertToDataUrl(url, log);
            if (dataUrl) {
              parts.push(`[图片]\n${dataUrl}`);
            } else {
              parts.push(`[图片下载失败]\n原始链接: ${url}`);
            }
          } else {
            parts.push("[image]");
          }
        } else {
          parts.push(`[${t || "item"}]`);
        }
      }
      return parts.filter(Boolean).join("\n\n");
    }
    return "[mixed]";
  }

  // 其他消息类型使用同步函数
  return buildInboundBody(msg);
}

export function registerWecomWebhookTarget(target: WecomWebhookTarget): () => void {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  const next = [...existing, normalizedTarget];
  webhookTargets.set(key, next);
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) webhookTargets.set(key, updated);
    else webhookTargets.delete(key);
  };
}

export async function handleWecomWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const path = resolvePath(req);
  const targets = webhookTargets.get(path);
  if (!targets || targets.length === 0) return false;

  const firstTarget = targets[0]!;

  // 清理过期 stream 并检查超时补发
  pruneStreams(firstTarget.runtime.log);

  const query = resolveQueryParams(req);
  const timestamp = query.get("timestamp") ?? "";
  const nonce = query.get("nonce") ?? "";
  const signature = resolveSignatureParam(query);

  logVerbose(firstTarget, `incoming ${req.method} request on ${path} (timestamp=${timestamp}, nonce=${nonce}, signature=${signature})`);

  if (req.method === "GET") {
    const echostr = query.get("echostr") ?? "";
    if (!timestamp || !nonce || !signature || !echostr) {
      logVerbose(firstTarget, "GET request missing query params");
      res.statusCode = 400;
      res.end("missing query params");
      return true;
    }
    const target = targets.find((candidate) => {
      if (!candidate.account.configured || !candidate.account.token) return false;
      const ok = verifyWecomSignature({
        token: candidate.account.token,
        timestamp,
        nonce,
        encrypt: echostr,
        signature,
      });
      if (!ok) {
        logVerbose(candidate, `signature verification failed for echostr (token=${candidate.account.token?.slice(0, 4)}...)`);
      }
      return ok;
    });
    if (!target || !target.account.encodingAESKey) {
      logVerbose(firstTarget, "no matching target for GET signature");
      res.statusCode = 401;
      res.end("unauthorized");
      return true;
    }
    try {
      const plain = decryptWecomEncrypted({
        encodingAESKey: target.account.encodingAESKey,
        receiveId: target.account.receiveId,
        encrypt: echostr,
      });
      logVerbose(target, "GET echostr decrypted successfully");
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(plain);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logVerbose(target, `GET decrypt failed: ${msg}`);
      res.statusCode = 400;
      res.end(msg || "decrypt failed");
      return true;
    }
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.end("Method Not Allowed");
    return true;
  }

  if (!timestamp || !nonce || !signature) {
    logVerbose(firstTarget, "POST request missing query params");
    res.statusCode = 400;
    res.end("missing query params");
    return true;
  }

  const body = await readJsonBody(req, 1024 * 1024);
  if (!body.ok) {
    logVerbose(firstTarget, `POST body read failed: ${body.error}`);
    res.statusCode = body.error === "payload too large" ? 413 : 400;
    res.end(body.error ?? "invalid payload");
    return true;
  }
  const record = body.value && typeof body.value === "object" ? (body.value as Record<string, unknown>) : null;
  const encrypt = record ? String(record.encrypt ?? record.Encrypt ?? "") : "";
  if (!encrypt) {
    logVerbose(firstTarget, "POST request missing encrypt field in body");
    res.statusCode = 400;
    res.end("missing encrypt");
    return true;
  }

  // Find the first target that validates the signature.
  const target = targets.find((candidate) => {
    if (!candidate.account.token) return false;
    const ok = verifyWecomSignature({
      token: candidate.account.token,
      timestamp,
      nonce,
      encrypt,
      signature,
    });
    if (!ok) {
      logVerbose(candidate, `signature verification failed for POST (token=${candidate.account.token?.slice(0, 4)}...)`);
    }
    return ok;
  });
  if (!target) {
    logVerbose(firstTarget, "no matching target for POST signature");
    res.statusCode = 401;
    res.end("unauthorized");
    return true;
  }

  if (!target.account.configured || !target.account.token || !target.account.encodingAESKey) {
    logVerbose(target, "target found but not fully configured");
    res.statusCode = 500;
    res.end("wecom not configured");
    return true;
  }

  let plain: string;
  try {
    plain = decryptWecomEncrypted({
      encodingAESKey: target.account.encodingAESKey,
      receiveId: target.account.receiveId,
      encrypt,
    });
    logVerbose(target, `decrypted POST message: ${plain}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logVerbose(target, `POST decrypt failed: ${msg}`);
    res.statusCode = 400;
    res.end(msg || "decrypt failed");
    return true;
  }

  const msg = parseWecomPlainMessage(plain);
  target.statusSink?.({ lastInboundAt: Date.now() });

  const msgtype = String(msg.msgtype ?? "").toLowerCase();
  const msgid = msg.msgid ? String(msg.msgid) : undefined;

  // Stream refresh callback: reply with current state (if any).
  if (msgtype === "stream") {
    const streamId = String((msg as WecomInboundStreamRefresh).stream?.id ?? "").trim();
    const state = streamId ? streams.get(streamId) : undefined;
    if (state) {
      // 更新最后刷新时间
      state.lastRefreshAt = Date.now();
      logVerbose(target, `stream refresh streamId=${streamId} started=${state.started} finished=${state.finished}`);
    }
    const reply = state ? buildStreamReplyFromState(state) : buildStreamReplyFromState({
      streamId: streamId || "unknown",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastRefreshAt: Date.now(),
      started: true,
      finished: true,
      content: "",
      images: [],
      proactiveSent: false,
    });
    jsonOk(res, buildEncryptedJsonReply({
      account: target.account,
      plaintextJson: reply,
      nonce,
      timestamp,
    }));
    return true;
  }

  // Dedupe: if we already created a stream for this msgid, return placeholder again.
  if (msgid && msgidToStreamId.has(msgid)) {
    const streamId = msgidToStreamId.get(msgid) ?? "";
    const reply = buildStreamPlaceholderReply(streamId);
    jsonOk(res, buildEncryptedJsonReply({
      account: target.account,
      plaintextJson: reply,
      nonce,
      timestamp,
    }));
    return true;
  }

  // enter_chat welcome event: optionally reply with text (allowed by spec).
  if (msgtype === "event") {
    const eventtype = String((msg as WecomInboundEvent).event?.eventtype ?? "").toLowerCase();
    if (eventtype === "enter_chat") {
      const welcome = target.account.config.welcomeText?.trim();
      const reply = welcome
        ? { msgtype: "text", text: { content: welcome } }
        : {};
      jsonOk(res, buildEncryptedJsonReply({
        account: target.account,
        plaintextJson: reply,
        nonce,
        timestamp,
      }));
      return true;
    }

    // For other events, reply empty to avoid timeouts.
    jsonOk(res, buildEncryptedJsonReply({
      account: target.account,
      plaintextJson: {},
      nonce,
      timestamp,
    }));
    return true;
  }

  // Default: respond with a stream placeholder and compute the actual reply async.
  const streamId = createStreamId();
  if (msgid) msgidToStreamId.set(msgid, streamId);

  // 确定发送目标（用于超时补发）
  const userid = msg.from?.userid?.trim() || "";
  const chatType = msg.chattype === "group" ? "group" : "direct";
  const chatId = msg.chattype === "group" ? (msg.chatid?.trim() || "") : userid;

  const now = Date.now();
  streams.set(streamId, {
    streamId,
    msgid,
    createdAt: now,
    updatedAt: now,
    lastRefreshAt: now,
    started: false,
    finished: false,
    content: "",
    images: [],
    proactiveSent: false,
    target: chatId,
    isGroup: chatType === "group",
    account: target.account,
  });

  // Kick off agent processing in the background.
  let core: PluginRuntime | null = null;
  try {
    core = getWecomRuntime();
  } catch (err) {
    // If runtime is not ready, we can't process the agent, but we should still
    // return the placeholder if possible, or handle it as a background error.
    logVerbose(target, `runtime not ready, skipping agent processing: ${String(err)}`);
  }

  if (core) {
    streams.get(streamId)!.started = true;
    const enrichedTarget: WecomWebhookTarget = { ...target, core };
    startAgentForStream({ target: enrichedTarget, accountId: target.account.accountId, msg, streamId }).catch((err) => {
      const state = streams.get(streamId);
      if (state) {
        state.error = err instanceof Error ? err.message : String(err);
        state.content = state.content || `Error: ${state.error}`;
        state.finished = true;
        state.updatedAt = Date.now();
      }
      target.runtime.error?.(`[${target.account.accountId}] wecom agent failed: ${String(err)}`);
    });
  } else {
    // In tests or uninitialized state, we might not have a core.
    // We mark it as finished to avoid hanging, but don't set an error content
    // immediately if we want to return the placeholder "1".
    const state = streams.get(streamId);
    if (state) {
      state.finished = true;
      state.updatedAt = Date.now();
    }
  }

  // Try to include a first chunk in the initial response (matches WeCom demo behavior).
  // If nothing is ready quickly, fall back to the placeholder "1".
  await waitForStreamContent(streamId, 800);
  const state = streams.get(streamId);
  const initialReply = state && (state.content.trim() || state.error)
    ? buildStreamReplyFromState(state)
    : buildStreamPlaceholderReply(streamId);
  jsonOk(res, buildEncryptedJsonReply({
    account: target.account,
    plaintextJson: initialReply,
    nonce,
    timestamp,
  }));

  logVerbose(target, `accepted msgtype=${msgtype || "unknown"} msgid=${msgid || "none"} streamId=${streamId}`);
  return true;
}
