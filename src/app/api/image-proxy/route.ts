/* eslint-disable @typescript-eslint/no-explicit-any */

import { HttpsProxyAgent } from 'https-proxy-agent';
import nodeFetch from 'node-fetch';
import { NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';

export const runtime = 'nodejs';

// Cloudflare Workers 免费版 Cache API 可用
// 在非 Cloudflare 环境（Vercel/Node.js）下回退到内存缓存
const memoryCache = new Map<string, { data: ArrayBuffer; contentType: string; timestamp: number }>();
const MEMORY_CACHE_TTL = 1000 * 60 * 60 * 24 * 7; // 7 天
const MEMORY_CACHE_MAX = 200; // 最多缓存 200 张图片

function isCloudflareEnvironment(): boolean {
  return (
    process.env.CF_PAGES === '1' || process.env.BUILD_TARGET === 'cloudflare'
  );
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function applyBangumiImageBaseUrl(
  imageUrl: string,
  imageBaseUrl?: string
): string {
  const normalizedBaseUrl = normalizeBaseUrl(imageBaseUrl || '');
  if (!normalizedBaseUrl) {
    return imageUrl;
  }

  if (imageUrl.startsWith(`${normalizedBaseUrl}/`)) {
    return imageUrl;
  }

  return `${normalizedBaseUrl}/${imageUrl}`;
}

function isBangumiImageUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return (
      hostname === 'lain.bgm.tv' ||
      hostname === 'r.bgm.tv' ||
      hostname.endsWith('.bgm.tv') ||
      hostname.endsWith('.bangumi.tv')
    );
  } catch {
    return false;
  }
}

/**
 * 生成缓存 key
 */
function getCacheKey(url: string, source?: string): string {
  return `img-proxy:${source || 'default'}:${url}`;
}

/**
 * 从 Cache API 读取缓存（Cloudflare 环境）
 */
async function getFromCacheApi(key: string): Promise<{ data: ArrayBuffer; contentType: string } | null> {
  try {
    if (typeof caches !== 'undefined' && caches.default) {
      const cache = caches.default;
      const cached = await cache.match(new Request(`https://cache.local/${encodeURIComponent(key)}`));
      if (cached && cached.ok) {
        const contentType = cached.headers.get('Content-Type') || 'image/jpeg';
        const data = await cached.arrayBuffer();
        return { data, contentType };
      }
    }
  } catch {
    // Cache API 不可用，忽略
  }
  return null;
}

/**
 * 写入 Cache API（Cloudflare 环境）
 */
async function putToCacheApi(key: string, data: ArrayBuffer, contentType: string): Promise<void> {
  try {
    if (typeof caches !== 'undefined' && caches.default) {
      const cache = caches.default;
      const response = new Response(data, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=604800, s-maxage=604800',
        },
      });
      // waitUntil 让缓存在响应后写入，不阻塞响应
      if (typeof (globalThis as any).waitUntil === 'function') {
        (globalThis as any).waitUntil(cache.put(
          new Request(`https://cache.local/${encodeURIComponent(key)}`),
          response
        ));
      } else {
        await cache.put(
          new Request(`https://cache.local/${encodeURIComponent(key)}`),
          response
        );
      }
    }
  } catch {
    // 缓存写入失败，忽略
  }
}

/**
 * 从内存缓存读取（Vercel/Node.js 环境）
 */
function getFromMemoryCache(key: string): { data: ArrayBuffer; contentType: string } | null {
  const cached = memoryCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > MEMORY_CACHE_TTL) {
    memoryCache.delete(key);
    return null;
  }
  return { data: cached.data, contentType: cached.contentType };
}

/**
 * 写入内存缓存
 */
function putToMemoryCache(key: string, data: ArrayBuffer, contentType: string): void {
  // 简单 LRU：超过上限时删除最早的
  if (memoryCache.size >= MEMORY_CACHE_MAX) {
    const firstKey = memoryCache.keys().next().value;
    if (firstKey) memoryCache.delete(firstKey);
  }
  memoryCache.set(key, { data, contentType, timestamp: Date.now() });
}

async function fetchImage(
  imageUrl: string,
  options?: { source?: string }
): Promise<Response> {
  const isBangumiImage =
    options?.source === 'bangumi' || isBangumiImageUrl(imageUrl);
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    Referer: isBangumiImage ? 'https://bgm.tv/' : 'https://movie.douban.com/',
  };

  const config = isBangumiImage ? await getConfig() : null;
  const targetUrl = isBangumiImage
    ? applyBangumiImageBaseUrl(imageUrl, config?.SiteConfig.BangumiImageBaseUrl)
    : imageUrl;

  // Cloudflare 环境直接用原生 fetch（不支持 node-fetch 和 https-proxy-agent）
  if (!isBangumiImage || isCloudflareEnvironment()) {
    return fetch(targetUrl, { headers, signal: AbortSignal.timeout(15000) });
  }

  const proxy = config?.SiteConfig.BangumiProxy?.trim();
  const fetchOptions: any = {
    headers,
    signal: AbortSignal.timeout(proxy ? 30000 : 15000),
  };

  if (proxy) {
    fetchOptions.agent = new HttpsProxyAgent(proxy, {
      timeout: 30000,
      keepAlive: false,
    });
  }

  return nodeFetch(targetUrl, fetchOptions) as unknown as Promise<Response>;
}

// 1x1 透明 PNG 占位图
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

// OrionTV 兼容接口
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get('url');
  const source = searchParams.get('source') || undefined;

  if (!imageUrl) {
    return NextResponse.json({ error: 'Missing image URL' }, { status: 400 });
  }

  const cacheKey = getCacheKey(imageUrl, source);

  // 1. 先查缓存（Cache API 或内存缓存）
  let cached: { data: ArrayBuffer; contentType: string } | null = null;

  if (isCloudflareEnvironment()) {
    cached = await getFromCacheApi(cacheKey);
  } else {
    cached = getFromMemoryCache(cacheKey);
  }

  if (cached) {
    const headers = new Headers();
    headers.set('Content-Type', cached.contentType);
    headers.set('Cache-Control', 'public, max-age=604800, s-maxage=604800');
    headers.set('X-Cache', 'HIT');
    return new Response(cached.data, { status: 200, headers });
  }

  // 2. 缓存未命中，fetch 原图
  try {
    const imageResponse = await fetchImage(imageUrl, { source });

    if (!imageResponse.ok) {
      // 返回占位图，避免前端显示裂图
      const headers = new Headers();
      headers.set('Content-Type', 'image/png');
      headers.set('Cache-Control', 'no-cache');
      headers.set('X-Cache', 'MISS-FAILED');
      return new Response(PLACEHOLDER_PNG, { status: 200, headers });
    }

    const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';

    if (!imageResponse.body) {
      const headers = new Headers();
      headers.set('Content-Type', 'image/png');
      headers.set('Cache-Control', 'no-cache');
      return new Response(PLACEHOLDER_PNG, { status: 200, headers });
    }

    // 读取图片数据到内存（用于缓存）
    const imageBuffer = await imageResponse.arrayBuffer();

    // 3. 写入缓存
    if (isCloudflareEnvironment()) {
      await putToCacheApi(cacheKey, imageBuffer, contentType);
    } else {
      putToMemoryCache(cacheKey, imageBuffer, contentType);
    }

    // 4. 返回图片
    const headers = new Headers();
    headers.set('Content-Type', contentType);
    headers.set('Cache-Control', 'public, max-age=604800, s-maxage=604800');
    headers.set('CDN-Cache-Control', 'public, s-maxage=604800');
    headers.set('Vercel-CDN-Cache-Control', 'public, s-maxage=604800');
    headers.set('Netlify-Vary', 'query');
    headers.set('X-Cache', 'MISS');

    return new Response(imageBuffer, { status: 200, headers });
  } catch (error) {
    console.error('图片代理请求失败:', error);
    // 返回占位图而不是错误，避免前端显示裂图
    const headers = new Headers();
    headers.set('Content-Type', 'image/png');
    headers.set('Cache-Control', 'no-cache');
    headers.set('X-Cache', 'ERROR');
    return new Response(PLACEHOLDER_PNG, { status: 200, headers });
  }
}
