"use strict";

importScripts("db.js", "opaque-material.js", "video.js");

const MAX_IMAGE_BYTES = 60 * 1024 * 1024;
const DEFAULT_CACHE_MB = 100;
const DEFAULT_MAX_ITEMS = 1000;
const MAX_DOWNLOAD_ATTEMPTS = 3;
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "avif", "gif"]);
const MIME_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif"
};

const processing = new Map();
const downloadJobs = new Map();
let cleanupPromise = null;
const CAPTURE_MODE_ALL = "all_opened";
const CAPTURE_MODE_CURRENT = "current_only";

async function getCaptureMode() {
  const stored = await storageGet({ captureMode: CAPTURE_MODE_CURRENT });
  return stored.captureMode === CAPTURE_MODE_ALL ? CAPTURE_MODE_ALL : CAPTURE_MODE_CURRENT;
}

async function getExtensionEnabled() {
  const stored = await storageGet({ extensionEnabled: true });
  return stored.extensionEnabled !== false;
}

async function broadcastExtensionEnabled(enabled) {
  const tabs = await chrome.tabs.query({ url: ["https://*.doubao.com/*", "http://*.doubao.com/*"] });
  await Promise.all(tabs.map((tab) => new Promise((resolve) => {
    if (!tab.id) return resolve();
    chrome.tabs.sendMessage(tab.id, { type: "EXTENSION_ENABLED_CHANGED", enabled }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  })));
}

async function shouldPersistFromSender(sender) {
  if (!await getExtensionEnabled()) return false;
  if (await getCaptureMode() === CAPTURE_MODE_ALL) return true;
  if (!sender?.tab?.id) return false;
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs.some((tab) => tab.id === sender.tab.id);
}

function isAllowedUrl(value) {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "byteimg.com" || url.hostname.endsWith(".byteimg.com"));
  } catch (_) {
    return false;
  }
}

function sanitizeId(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 180);
}

function safeText(value, maxLength, fallback = "") {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maxLength) : fallback;
}

function idFromUrl(value) {
  try {
    return sanitizeId(
      decodeURIComponent(new URL(value).pathname)
        .replace(/\.(?:jpe?g|png|webp|avif|gif)$/i, "")
    ) || crypto.randomUUID();
  } catch (_) {
    return crypto.randomUUID();
  }
}

function isConcreteChatId(chatId) {
  const id = String(chatId || "").trim();
  if (!id || id.length < 10) return false;
  if (/^(home|chat|conversation|new|index|explore|discover|bot|agent)$/i.test(id)) return false;
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

function readImageMetrics(value) {
  const width = Number(value?.width || value?.image_width || 0);
  const height = Number(value?.height || value?.image_height || 0);
  const sourceUrl = value?.image_ori_raw_url || value?.image_ori_url || value?.best_url || "";
  const extension = value?.extension || extensionFromUrl(sourceUrl);
  return {
    width: width > 0 ? width : 0,
    height: height > 0 ? height : 0,
    extension: extension || null
  };
}

function normalizeRecord(value) {
  if (!value || typeof value !== "object") return null;
  const validUrl = (url) => isAllowedUrl(url) ? url : null;
  const rawUrl = validUrl(value.image_ori_raw_url);
  const oriUrl = validUrl(value.image_ori_url);
  const previewUrl = validUrl(value.image_preview_url);
  const thumbUrl = validUrl(value.image_thumb_url);
  // 入库必须带无水印原图字段。
  if (!rawUrl) return null;
  const bestUrl = rawUrl || oriUrl || previewUrl || thumbUrl;
  if (!bestUrl) return null;
  const conversationChatId = safeText(value.conversation_chat_id, 200);
  // 拒绝首页 / 未进入具体会话时扫到的推荐图、示例图。
  if (!isConcreteChatId(conversationChatId)) return null;

  const metrics = readImageMetrics(value);

  return {
    image_id: sanitizeId(value.image_id) || idFromUrl(bestUrl),
    image_ori_raw_url: rawUrl,
    image_ori_url: oriUrl,
    image_preview_url: previewUrl,
    image_thumb_url: thumbUrl,
    best_url: bestUrl,
    width: metrics.width,
    height: metrics.height,
    extension: metrics.extension,
    captured_at: Number.isFinite(value.captured_at) ? value.captured_at : Date.now(),
    conversation_id: safeText(value.conversation_id, 500, "legacy"),
    conversation_chat_id: conversationChatId,
    conversation_title: safeText(value.conversation_title, 120, "未分类历史"),
    page_url: safeText(value.page_url, 1000)
  };
}

function isPlausibleGeneratedSize(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!w || !h) return false;
  const shortSide = Math.min(w, h);
  const longSide = Math.max(w, h);
  if (shortSide < 256) return false;
  if (longSide / shortSide > 2.6) return false;
  return true;
}

function extensionFromUrl(value) {
  try {
    const filename = decodeURIComponent(new URL(value).pathname).split("/").pop() || "";
    const match = filename.match(/\.([a-zA-Z0-9]{2,5})$/);
    const extension = match?.[1]?.toLowerCase();
    return IMAGE_EXTENSIONS.has(extension) ? extension : null;
  } catch (_) {
    return null;
  }
}

function resolveExtension(url, mimeType) {
  const urlExtension = extensionFromUrl(url);
  const normalizedMime = String(mimeType || "").split(";")[0].trim().toLowerCase();
  const mimeExtension = MIME_EXTENSIONS[normalizedMime] || null;
  if (urlExtension && mimeExtension) {
    const bothJpeg = ["jpg", "jpeg"].includes(urlExtension) && mimeExtension === "jpg";
    return bothJpeg || urlExtension === mimeExtension ? urlExtension : mimeExtension;
  }
  return mimeExtension || urlExtension || "jpg";
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function createThumbnail(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const size = 160;
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#f4f4f5";
    context.fillRect(0, 0, size, size);
    const scale = Math.max(size / bitmap.width, size / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.drawImage(bitmap, (size - width) / 2, (size - height) / 2, width, height);
    const thumbnailBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
    return { thumbnailBlob, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

function mergeConversationMeta(existing, record) {
  const existingId = String(existing?.conversation_id || "").trim();
  const hasExisting = existingId && existingId !== "legacy";
  if (hasExisting) {
    return {
      conversation_id: existingId,
      conversation_chat_id: existing.conversation_chat_id || record.conversation_chat_id || "",
      conversation_title: pickConversationTitle(existing.conversation_title, record.conversation_title),
      page_url: existing.page_url || record.page_url || ""
    };
  }
  return {
    conversation_id: record.conversation_id || "legacy",
    conversation_chat_id: record.conversation_chat_id || "",
    conversation_title: record.conversation_title || "未分类历史",
    page_url: record.page_url || ""
  };
}

async function processImage(input) {
  const record = normalizeRecord(input);
  if (!record) throw new Error("图片数据或域名不符合要求");
  if (processing.has(record.image_id)) return processing.get(record.image_id);

  const task = (async () => {
    const existing = await getImage(record.image_id);
    const sourceUrl = record.image_ori_raw_url || record.image_ori_url || record.best_url;

    if (existing && existing.raw_url === sourceUrl && existing.thumbnail_blob) {
      // 已归属其他会话的记录不要被当前页重新打标签「抢」走。
      const merged = {
        ...existing,
        image_ori_raw_url: record.image_ori_raw_url || existing.image_ori_raw_url,
        image_ori_url: record.image_ori_url || existing.image_ori_url,
        image_preview_url: record.image_preview_url || existing.image_preview_url,
        image_thumb_url: record.image_thumb_url || existing.image_thumb_url,
        width: existing.width || record.width || 0,
        height: existing.height || record.height || 0,
        extension: existing.extension || record.extension || null,
        ...mergeConversationMeta(existing, record),
        updated_at: Date.now()
      };
      await saveImage(merged);
      return merged;
    }

    const sameUrl = await getImageByRawUrl(sourceUrl);
    if (sameUrl?.thumbnail_blob) {
      // 同一原图已入库：保留原会话归属，仅补齐字段。
      const merged = {
        ...sameUrl,
        image_ori_raw_url: record.image_ori_raw_url || sameUrl.image_ori_raw_url,
        image_ori_url: record.image_ori_url || sameUrl.image_ori_url,
        image_preview_url: record.image_preview_url || sameUrl.image_preview_url,
        image_thumb_url: record.image_thumb_url || sameUrl.image_thumb_url,
        width: sameUrl.width || record.width || 0,
        height: sameUrl.height || record.height || 0,
        extension: sameUrl.extension || record.extension || null,
        ...mergeConversationMeta(sameUrl, record),
        updated_at: Date.now()
      };
      await saveImage(merged);
      return merged;
    }

    const response = await fetch(sourceUrl, { credentials: "omit", cache: "force-cache" });
    if (!response.ok) throw new Error(`原图请求失败：HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_IMAGE_BYTES) throw new Error("原图超过 60 MB，已停止缓存");

    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim();
    if (contentType && !contentType.startsWith("image/")) throw new Error("服务器返回的内容不是图片");
    const blob = await response.blob();
    if (blob.size > MAX_IMAGE_BYTES) throw new Error("原图超过 60 MB，已停止缓存");
    if (blob.type && !blob.type.startsWith("image/")) throw new Error("下载内容不是图片格式");

    const thumbnail = await createThumbnail(blob);
    if (!isPlausibleGeneratedSize(thumbnail.width, thumbnail.height)) {
      throw new Error("尺寸不像生成图，已忽略");
    }
    const mimeType = contentType || blob.type || "image/jpeg";
    const saved = {
      image_id: record.image_id,
      raw_url: sourceUrl,
      image_ori_raw_url: record.image_ori_raw_url,
      image_ori_url: record.image_ori_url,
      image_preview_url: record.image_preview_url,
      image_thumb_url: record.image_thumb_url,
      thumbnail_blob: thumbnail.thumbnailBlob,
      mime_type: mimeType,
      extension: resolveExtension(sourceUrl, mimeType) || record.extension || "jpg",
      width: thumbnail.width || record.width || 0,
      height: thumbnail.height || record.height || 0,
      captured_at: record.captured_at,
      updated_at: Date.now(),
      conversation_id: record.conversation_id,
      conversation_chat_id: record.conversation_chat_id,
      conversation_title: record.conversation_title,
      page_url: record.page_url
    };
    await saveImage(saved);
    return saved;
  })();

  processing.set(record.image_id, task);
  try {
    return await task;
  } finally {
    processing.delete(record.image_id);
  }
}

function storageGet(defaults) {
  return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
}

function storageSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

async function persistDownloadJobs() {
  const activeDownloadJobs = Array.from(downloadJobs.entries()).map(([downloadId, job]) => ({
    downloadId,
    job
  }));
  await storageSet({ activeDownloadJobs });
}

async function restoreDownloadJobs() {
  const values = await storageGet({ activeDownloadJobs: [] });
  for (const entry of values.activeDownloadJobs || []) {
    if (Number.isInteger(entry?.downloadId) && entry.job?.url && entry.job?.filename) {
      downloadJobs.set(entry.downloadId, entry.job);
    }
  }
}

const downloadJobsReady = restoreDownloadJobs().catch(() => {});

async function getCachePolicy() {
  const values = await storageGet({ cacheLimitMb: DEFAULT_CACHE_MB, cacheMaxItems: DEFAULT_MAX_ITEMS });
  return {
    cacheLimitMb: Math.min(1000, Math.max(25, Number(values.cacheLimitMb) || DEFAULT_CACHE_MB)),
    cacheMaxItems: Math.min(10000, Math.max(100, Number(values.cacheMaxItems) || DEFAULT_MAX_ITEMS))
  };
}

async function enforceCachePolicy() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    const policy = await getCachePolicy();
    return pruneCache(policy.cacheLimitMb * 1024 * 1024, policy.cacheMaxItems);
  })();
  try {
    return await cleanupPromise;
  } finally {
    cleanupPromise = null;
  }
}

async function cacheStatus() {
  const [stats, policy] = await Promise.all([getCacheStats(), getCachePolicy()]);
  return { ...stats, ...policy };
}

function timestamp() {
  const date = new Date();
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function downloadWithChrome(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(downloadId);
    });
  });
}

function notifyRuntime(message) {
  try {
    chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
  } catch (_) {
    // Popup 关闭时没有接收者属于正常情况。
  }
}

async function prepareDownload(input, index = 0) {
  const record = normalizeRecord(input);
  if (!record) throw new Error("下载地址无效");
  const sourceUrl = record.image_ori_raw_url || record.image_ori_url || record.best_url;
  let cached = await getImage(record.image_id);
  if (!cached || cached.raw_url !== sourceUrl) {
    try {
      cached = await processImage(record);
    } catch (_) {
      cached = null;
    }
  }
  const extension = cached?.extension || extensionFromUrl(sourceUrl) || "jpg";
  const suffix = index ? `_${String(index).padStart(2, "0")}` : "";
  return {
    imageId: record.image_id,
    url: sourceUrl,
    filename: `doubao_original_images/doubao_${timestamp()}${suffix}.${extension}`,
    attempt: 0,
    maxAttempts: MAX_DOWNLOAD_ATTEMPTS
  };
}

async function startDownloadJob(job) {
  await downloadJobsReady;
  let lastError;
  while (job.attempt < job.maxAttempts) {
    job.attempt += 1;
    try {
      const downloadId = await downloadWithChrome({
        url: job.url,
        filename: job.filename,
        saveAs: false,
        conflictAction: "uniquify"
      });
      downloadJobs.set(downloadId, job);
      await persistDownloadJobs();
      notifyRuntime({
        type: job.attempt > 1 ? "DOWNLOAD_RETRYING" : "DOWNLOAD_STARTED",
        image_id: job.imageId,
        attempt: job.attempt,
        max_attempts: job.maxAttempts,
        filename: job.filename
      });
      return { downloadId, filename: job.filename, attempt: job.attempt };
    } catch (error) {
      lastError = error;
      notifyRuntime({
        type: "DOWNLOAD_RETRYING",
        image_id: job.imageId,
        attempt: job.attempt,
        max_attempts: job.maxAttempts,
        error: error.message
      });
    }
  }
  throw lastError || new Error("下载重试失败");
}

async function queueDownload(input, index = 0) {
  return startDownloadJob(await prepareDownload(input, index));
}

chrome.downloads.onChanged.addListener((delta) => {
  downloadJobsReady.then(async () => {
    const job = downloadJobs.get(delta.id);
    if (!job) return;

    if (delta.state?.current === "complete") {
      downloadJobs.delete(delta.id);
      await persistDownloadJobs().catch(() => {});
      notifyRuntime({
        type: "DOWNLOAD_COMPLETE",
        image_id: job.imageId,
        filename: job.filename,
        attempts: job.attempt
      });
      return;
    }

    if (delta.state?.current !== "interrupted") return;
    downloadJobs.delete(delta.id);
    await persistDownloadJobs().catch(() => {});
    const reason = delta.error?.current || "DOWNLOAD_INTERRUPTED";
    if (reason === "USER_CANCELED") {
      notifyRuntime({ type: "DOWNLOAD_CANCELED", image_id: job.imageId, filename: job.filename });
      return;
    }

    if (job.attempt < job.maxAttempts) {
      startDownloadJob(job).catch((error) => {
        notifyRuntime({
          type: "DOWNLOAD_FAILED",
          image_id: job.imageId,
          filename: job.filename,
          attempts: job.attempt,
          error: error.message
        });
      });
    } else {
      notifyRuntime({
        type: "DOWNLOAD_FAILED",
        image_id: job.imageId,
        filename: job.filename,
        attempts: job.attempt,
        error: reason
      });
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "DOUBAO_IMAGES") {
    (async () => {
      try {
        if (!await shouldPersistFromSender(sender)) {
          sendResponse({ ok: true, skipped: true, success: 0, total: 0 });
          return;
        }
        const images = Array.isArray(message.images) ? message.images.slice(0, 200) : [];
        const results = await mapLimit(images, 3, async (image) => {
          try {
            // 已有同一原图且归属其它会话时，不改写成当前会话。
            const normalized = normalizeRecord(image);
            if (!normalized) return { ok: false, error: "图片数据或域名不符合要求" };
            const existingById = await getImage(normalized.image_id);
            const sourceUrl = normalized.image_ori_raw_url || normalized.image_ori_url || normalized.best_url;
            const existingByUrl = sourceUrl ? await getImageByRawUrl(sourceUrl) : null;
            const existing = existingById || existingByUrl;
            if (existing?.conversation_id &&
                existing.conversation_id !== "legacy" &&
                normalized.conversation_id &&
                existing.conversation_id !== normalized.conversation_id) {
              return { ok: true, image: existing, skipped: "foreign_conversation" };
            }
            return { ok: true, image: await processImage(image) };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        });
        await enforceCachePolicy();
        const success = results.filter((item) => item.ok).length;
        notifyRuntime({ type: "GALLERY_UPDATED" });
        sendResponse({ ok: success > 0 || images.length === 0, success, total: images.length, results });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.type === "GET_CAPTURE_MODE") {
    getCaptureMode()
      .then((captureMode) => sendResponse({ ok: true, captureMode }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "GET_EXTENSION_ENABLED") {
    getExtensionEnabled()
      .then((enabled) => sendResponse({ ok: true, enabled }))
      .catch((error) => sendResponse({ ok: false, error: error.message, enabled: true }));
    return true;
  }

  if (message.type === "SET_EXTENSION_ENABLED") {
    (async () => {
      const enabled = message.enabled !== false;
      await storageSet({ extensionEnabled: enabled });
      await broadcastExtensionEnabled(enabled);
      sendResponse({ ok: true, enabled });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "SET_CAPTURE_MODE") {
    (async () => {
      const captureMode = message.captureMode === CAPTURE_MODE_CURRENT
        ? CAPTURE_MODE_CURRENT
        : CAPTURE_MODE_ALL;
      await storageSet({ captureMode });
      sendResponse({ ok: true, captureMode });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "GET_IMAGES") {
    (async () => {
      try {
        await pruneImplausibleImages();
        const images = await getAllImages();
        sendResponse({ ok: true, images });
      } catch (error) {
        sendResponse({ ok: false, error: error.message, images: [] });
      }
    })();
    return true;
  }

  if (message.type === "DOWNLOAD_IMAGE") {
    queueDownload(message.image)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "BATCH_DOWNLOAD") {
    (async () => {
      try {
        const images = Array.isArray(message.images) ? message.images.slice(0, 100) : [];
        const results = await mapLimit(images, 4, async (image, index) => {
          try {
            return { ok: true, ...(await queueDownload(image, index + 1)) };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        });
        const success = results.filter((item) => item.ok).length;
        sendResponse({ ok: success > 0, success, failed: results.length - success, results });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.type === "DELETE_IMAGE") {
    deleteImage(message.image_id)
      .then(() => {
        notifyRuntime({ type: "GALLERY_UPDATED" });
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "DELETE_CONVERSATION") {
    deleteImagesByConversation(message.conversation_id)
      .then((deleted) => {
        notifyRuntime({ type: "GALLERY_UPDATED" });
        sendResponse({ ok: true, deleted });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "UPDATE_CONVERSATION_TITLE") {
    updateConversationTitles({
      conversation_id: message.conversation_id,
      conversation_chat_id: message.conversation_chat_id,
      conversation_title: message.conversation_title
    })
      .then((result) => {
        if (result.updated > 0) notifyRuntime({ type: "GALLERY_UPDATED" });
        sendResponse({ ok: true, ...result });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "CLEAR_IMAGES") {
    clearImages()
      .then(() => {
        notifyRuntime({ type: "GALLERY_UPDATED" });
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "GET_CACHE_STATS") {
    cacheStatus()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "SET_CACHE_LIMIT") {
    (async () => {
      try {
        const cacheLimitMb = Math.min(1000, Math.max(25, Number(message.cache_limit_mb) || DEFAULT_CACHE_MB));
        const cacheMaxItems = Math.min(10000, Math.max(100, Number(message.cache_max_items) || DEFAULT_MAX_ITEMS));
        await storageSet({ cacheLimitMb, cacheMaxItems });
        const cleanup = await enforceCachePolicy();
        notifyRuntime({ type: "GALLERY_UPDATED" });
        sendResponse({ ok: true, cacheLimitMb, cacheMaxItems, cleanup });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.type === "CLEANUP_CACHE") {
    enforceCachePolicy()
      .then((result) => {
        notifyRuntime({ type: "GALLERY_UPDATED" });
        sendResponse({ ok: true, ...result });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
