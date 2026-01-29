/**
 * WeCom API client for proactive messaging
 * 企业微信主动发送消息 API
 */

import type { ResolvedWecomAccount } from "./types.js";

const WECOM_API_BASE = "https://qyapi.weixin.qq.com/cgi-bin";

// Token cache: corpId -> { token, expiresAt }
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export type WecomApiError = {
  errcode: number;
  errmsg: string;
};

export type WecomTokenResponse = {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  expires_in?: number;
};

export type WecomSendResponse = {
  errcode: number;
  errmsg: string;
  msgid?: string;
};

export type WecomMediaUploadResponse = {
  errcode?: number;
  errmsg?: string;
  type?: string;
  media_id?: string;
  created_at?: string;
};

/**
 * Get access token for WeCom API
 * Caches token until 5 minutes before expiry
 */
export async function getAccessToken(account: ResolvedWecomAccount): Promise<string> {
  const { corpId, secret } = account;
  if (!corpId || !secret) {
    throw new Error("WeCom outbound not configured: missing corpId or secret");
  }

  const cacheKey = `${corpId}:${secret.slice(0, 8)}`;
  const cached = tokenCache.get(cacheKey);
  const now = Date.now();

  // Return cached token if still valid (with 5 min buffer)
  if (cached && cached.expiresAt > now + 5 * 60 * 1000) {
    return cached.token;
  }

  // Fetch new token
  const url = `${WECOM_API_BASE}/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`;
  const res = await fetch(url);
  const data = (await res.json()) as WecomTokenResponse;

  if (data.errcode && data.errcode !== 0) {
    throw new Error(`WeCom gettoken failed: ${data.errcode} ${data.errmsg}`);
  }

  if (!data.access_token) {
    throw new Error("WeCom gettoken returned no access_token");
  }

  // Cache token
  const expiresIn = data.expires_in ?? 7200;
  tokenCache.set(cacheKey, {
    token: data.access_token,
    expiresAt: now + expiresIn * 1000,
  });

  return data.access_token;
}

/**
 * Send text message to a user or group
 */
export async function sendTextMessage(params: {
  account: ResolvedWecomAccount;
  target: string; // userId or chatId (group)
  text: string;
  isGroup?: boolean;
}): Promise<WecomSendResponse> {
  const { account, target, text, isGroup } = params;
  const token = await getAccessToken(account);

  if (isGroup || target.startsWith("wr")) {
    // Group chat - use appchat/send API
    const url = `${WECOM_API_BASE}/appchat/send?access_token=${encodeURIComponent(token)}`;
    const body = {
      chatid: target,
      msgtype: "text",
      text: { content: text },
      safe: 0,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return (await res.json()) as WecomSendResponse;
  } else {
    // Direct message - use message/send API
    const url = `${WECOM_API_BASE}/message/send?access_token=${encodeURIComponent(token)}`;
    const body = {
      touser: target,
      msgtype: "text",
      agentid: account.agentId,
      text: { content: text },
      safe: 0,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return (await res.json()) as WecomSendResponse;
  }
}

/**
 * Upload media file to WeCom
 */
export async function uploadMedia(params: {
  account: ResolvedWecomAccount;
  type: "image" | "voice" | "video" | "file";
  buffer: Buffer;
  filename: string;
  contentType?: string;
}): Promise<string> {
  const { account, type, buffer, filename, contentType } = params;
  const token = await getAccessToken(account);

  const url = `${WECOM_API_BASE}/media/upload?access_token=${encodeURIComponent(token)}&type=${type}`;

  // Create form data manually for Node.js
  const boundary = `----WebKitFormBoundary${Date.now().toString(16)}`;
  const mimeType = contentType || getMimeType(filename);

  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="media"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, buffer, footer]);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": body.length.toString(),
    },
    body,
  });

  const data = (await res.json()) as WecomMediaUploadResponse;

  if (data.errcode && data.errcode !== 0) {
    throw new Error(`WeCom media upload failed: ${data.errcode} ${data.errmsg}`);
  }

  if (!data.media_id) {
    throw new Error("WeCom media upload returned no media_id");
  }

  return data.media_id;
}

/**
 * Send image message
 */
export async function sendImageMessage(params: {
  account: ResolvedWecomAccount;
  target: string;
  mediaId: string;
  isGroup?: boolean;
}): Promise<WecomSendResponse> {
  const { account, target, mediaId, isGroup } = params;
  const token = await getAccessToken(account);

  if (isGroup || target.startsWith("wr")) {
    // Group chat
    const url = `${WECOM_API_BASE}/appchat/send?access_token=${encodeURIComponent(token)}`;
    const body = {
      chatid: target,
      msgtype: "image",
      image: { media_id: mediaId },
      safe: 0,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return (await res.json()) as WecomSendResponse;
  } else {
    // Direct message
    const url = `${WECOM_API_BASE}/message/send?access_token=${encodeURIComponent(token)}`;
    const body = {
      touser: target,
      msgtype: "image",
      agentid: account.agentId,
      image: { media_id: mediaId },
      safe: 0,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return (await res.json()) as WecomSendResponse;
  }
}

/**
 * Send file message
 */
export async function sendFileMessage(params: {
  account: ResolvedWecomAccount;
  target: string;
  mediaId: string;
  isGroup?: boolean;
}): Promise<WecomSendResponse> {
  const { account, target, mediaId, isGroup } = params;
  const token = await getAccessToken(account);

  if (isGroup || target.startsWith("wr")) {
    // Group chat
    const url = `${WECOM_API_BASE}/appchat/send?access_token=${encodeURIComponent(token)}`;
    const body = {
      chatid: target,
      msgtype: "file",
      file: { media_id: mediaId },
      safe: 0,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return (await res.json()) as WecomSendResponse;
  } else {
    // Direct message
    const url = `${WECOM_API_BASE}/message/send?access_token=${encodeURIComponent(token)}`;
    const body = {
      touser: target,
      msgtype: "file",
      agentid: account.agentId,
      file: { media_id: mediaId },
      safe: 0,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return (await res.json()) as WecomSendResponse;
  }
}

function getMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    mp3: "audio/mpeg",
    amr: "audio/amr",
    mp4: "video/mp4",
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip",
    txt: "text/plain",
  };
  return mimeTypes[ext ?? ""] ?? "application/octet-stream";
}
