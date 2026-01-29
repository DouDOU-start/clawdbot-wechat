/**
 * 企业微信 API 客户端
 * 用于获取 access_token 和下载媒体文件
 */

import crypto from "node:crypto";

// access_token 缓存
type TokenCache = {
  token: string;
  expiresAt: number;
};

const tokenCache = new Map<string, TokenCache>();

// access_token 提前刷新时间（5分钟）
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * 生成缓存 key
 */
function getCacheKey(corpId: string, secret: string): string {
  return `${corpId}:${crypto.createHash("md5").update(secret).digest("hex").slice(0, 8)}`;
}

/**
 * 获取 access_token
 * @see https://developer.work.weixin.qq.com/document/path/91039
 */
export async function getAccessToken(params: {
  corpId: string;
  secret: string;
}): Promise<string> {
  const { corpId, secret } = params;
  const cacheKey = getCacheKey(corpId, secret);

  // 检查缓存
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
    return cached.token;
  }

  // 请求新的 access_token
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`获取 access_token 失败: HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      errcode?: number;
      errmsg?: string;
      access_token?: string;
      expires_in?: number;
    };

    if (data.errcode && data.errcode !== 0) {
      throw new Error(`获取 access_token 失败: ${data.errmsg || `errcode=${data.errcode}`}`);
    }

    if (!data.access_token) {
      throw new Error("获取 access_token 失败: 响应中没有 access_token");
    }

    // 缓存 token
    const expiresIn = data.expires_in ?? 7200;
    tokenCache.set(cacheKey, {
      token: data.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    });

    return data.access_token;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/**
 * 下载媒体文件（图片、文件等）
 * @see https://developer.work.weixin.qq.com/document/path/90254
 */
export async function downloadMedia(params: {
  accessToken: string;
  mediaId: string;
}): Promise<{ buffer: Buffer; contentType: string } | null> {
  const { accessToken, mediaId } = params;
  const url = `https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${encodeURIComponent(accessToken)}&media_id=${encodeURIComponent(mediaId)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000); // 60秒超时

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    const contentType = res.headers.get("content-type") || "";

    // 如果返回 JSON，说明是错误响应
    if (contentType.includes("application/json")) {
      const data = (await res.json()) as {
        errcode?: number;
        errmsg?: string;
      };
      if (data.errcode && data.errcode !== 0) {
        throw new Error(`下载媒体文件失败: ${data.errmsg || `errcode=${data.errcode}`}`);
      }
      return null;
    }

    if (!res.ok) {
      throw new Error(`下载媒体文件失败: HTTP ${res.status}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/**
 * 从 URL 下载图片（用于智能机器人回调中的图片 URL）
 * 智能机器人的图片 URL 是临时链接，可以直接访问
 */
export async function downloadImageFromUrl(imageUrl: string): Promise<{
  buffer: Buffer;
  contentType: string;
  base64: string;
  md5: string;
} | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(imageUrl, {
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

    // 检查是否是图片
    if (!contentType.startsWith("image/")) {
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    // 检查大小限制（10MB）
    if (buffer.length > 10 * 1024 * 1024) {
      return null;
    }

    const base64 = buffer.toString("base64");
    const md5 = crypto.createHash("md5").update(buffer).digest("hex");

    return { buffer, contentType, base64, md5 };
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

/**
 * 清除 access_token 缓存
 */
export function clearTokenCache(corpId?: string, secret?: string): void {
  if (corpId && secret) {
    const cacheKey = getCacheKey(corpId, secret);
    tokenCache.delete(cacheKey);
  } else {
    tokenCache.clear();
  }
}
