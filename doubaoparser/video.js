"use strict";

(() => {
  const DEBUGGER_VERSION = "1.3";
  const CHAIN_PATH = "/im/chain/single";
  const DOWNLOAD_CONCURRENCY = 2;
  const MAX_DOWNLOAD_ATTEMPTS = 2;
  const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
  const MAX_CAPTURED_PER_RESPONSE = 50;
  const CAPTURE_MODE_ALL = "all_opened";
  const CAPTURE_MODE_CURRENT = "current_only";
  const FALLBACK_HOSTS = ["doubao.com", "snssdk.com", "byteintlapi.com"];
  const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "mkv"]);
  let _opaqueSaltHex = "";

  const attachedTabs = new Set();
  const attachingTabs = new Set();
  const tabErrors = new Map();
  const downloadQueue = [];
  const queuedDownloadKeys = new Set();
  const downloadWaiters = new Map();
  let activeDownloads = 0;
  let captureMode = CAPTURE_MODE_CURRENT;
  let extensionEnabled = true;

  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    if (!extensionEnabled) return;
    if (captureMode === CAPTURE_MODE_CURRENT) await syncTargetTabs();
    else {
      const tab = await safeGetTab(tabId);
      if (tab && isTargetPage(tab.url)) await ensureAttached(tabId);
    }
  });

  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (!extensionEnabled) {
      if (attachedTabs.has(tabId)) await detachTab(tabId);
      return;
    }
    const url = changeInfo.url || tab.url || "";
    if (isTargetPage(url) && (captureMode === CAPTURE_MODE_ALL || tab.active)) await ensureAttached(tabId);
    else if (attachedTabs.has(tabId)) await detachTab(tabId);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.captureMode) {
      captureMode = changes.captureMode.newValue === CAPTURE_MODE_CURRENT
        ? CAPTURE_MODE_CURRENT
        : CAPTURE_MODE_ALL;
    }
    if (changes.extensionEnabled) {
      extensionEnabled = changes.extensionEnabled.newValue !== false;
    }
    if (changes.captureMode || changes.extensionEnabled) {
      syncTargetTabs().catch((error) => console.warn("[Doubao Original Video] 切换捕获状态失败", error));
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    attachedTabs.delete(tabId);
    attachingTabs.delete(tabId);
    tabErrors.delete(tabId);
  });

  chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
    if (!tabId) return;
    attachedTabs.delete(tabId);
    attachingTabs.delete(tabId);
    if (reason && reason !== "target_closed") tabErrors.set(tabId, `视频拦截已断开：${reason}`);
  });

  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId && method === "Fetch.requestPaused" && params) {
      handlePausedRequest(source.tabId, params).catch((error) => {
        console.warn("[Doubao Original Video] 请求处理失败", error);
      });
    }
  });

  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta?.id || !delta.state || !downloadWaiters.has(delta.id)) return;
    if (delta.state.current === "complete" || delta.state.current === "interrupted") {
      downloadWaiters.get(delta.id).finish({
        state: delta.state.current,
        error: delta.error?.current || ""
      });
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;

    if (message.type === "GET_VIDEO_STATUS") {
      (async () => {
        const tab = await activeTab();
        if (extensionEnabled && tab?.id && isTargetPage(tab.url)) await ensureAttached(tab.id);
        sendResponse({
          ok: true,
          enabled: extensionEnabled,
          target_page: Boolean(tab && isTargetPage(tab.url)),
          attached: Boolean(extensionEnabled && tab?.id && attachedTabs.has(tab.id)),
          error: !extensionEnabled
            ? "扩展已关闭"
            : (tab?.id ? tabErrors.get(tab.id) || "" : ""),
          capture_mode: captureMode,
          conversation: tab ? conversationMeta(tab) : null
        });
      })().catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === "RECONNECT_VIDEO") {
      (async () => {
        if (!extensionEnabled) throw new Error("请先在 Popup 中启用去水印");
        const tab = await activeTab();
        if (!tab?.id || !isTargetPage(tab.url)) throw new Error("请先打开豆包对话页面");
        tabErrors.delete(tab.id);
        await detachTab(tab.id);
        await ensureAttached(tab.id);
        sendResponse({ ok: true, attached: attachedTabs.has(tab.id) });
      })().catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === "GET_VIDEOS") {
      getAllVideos()
        .then((videos) => sendResponse({ ok: true, videos }))
        .catch((error) => sendResponse({ ok: false, error: error.message, videos: [] }));
      return true;
    }

    if (message.type === "REFRESH_VIDEO") {
      refreshStoredVideo(message.video)
        .then((video) => sendResponse({ ok: true, video }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === "DOWNLOAD_VIDEO") {
      const video = normalizeVideoRecord(message.video);
      if (!video) {
        sendResponse({ ok: false, error: "视频记录无效" });
        return false;
      }
      enqueueVideoDownloads([video]);
      sendResponse({ ok: true, queued: 1 });
      return false;
    }

    if (message.type === "BATCH_VIDEO_DOWNLOAD") {
      const videos = Array.isArray(message.videos)
        ? message.videos.map(normalizeVideoRecord).filter(Boolean).slice(0, 100)
        : [];
      enqueueVideoDownloads(videos);
      sendResponse({ ok: true, queued: videos.length });
      return false;
    }

    if (message.type === "DELETE_VIDEO") {
      deleteVideo(String(message.video_record_id || ""))
        .then(() => {
          notify({ type: "GALLERY_UPDATED" });
          sendResponse({ ok: true });
        })
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === "DELETE_VIDEO_CONVERSATION") {
      deleteVideosByConversation(String(message.conversation_id || ""))
        .then((deleted) => {
          notify({ type: "GALLERY_UPDATED" });
          sendResponse({ ok: true, deleted });
        })
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === "CLEAR_VIDEOS") {
      clearVideos()
        .then(() => {
          notify({ type: "GALLERY_UPDATED" });
          sendResponse({ ok: true });
        })
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    return false;
  });

  async function syncTargetTabs() {
    const stored = await storageGet({
      captureMode: CAPTURE_MODE_CURRENT,
      extensionEnabled: true
    });
    captureMode = stored.captureMode === CAPTURE_MODE_ALL ? CAPTURE_MODE_ALL : CAPTURE_MODE_CURRENT;
    extensionEnabled = stored.extensionEnabled !== false;
    const tabs = await chrome.tabs.query({});
    const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const activeId = activeTabs[0]?.id || 0;
    const desired = new Set(
      extensionEnabled
        ? tabs
          .filter((tab) => tab.id && isTargetPage(tab.url) && (captureMode === CAPTURE_MODE_ALL || tab.id === activeId))
          .map((tab) => tab.id)
        : []
    );
    await Promise.all(Array.from(attachedTabs).filter((tabId) => !desired.has(tabId)).map(detachTab));
    await Promise.all(Array.from(desired).map(ensureAttached));
  }

  async function ensureAttached(tabId) {
    if (!extensionEnabled) return;
    if (attachedTabs.has(tabId) || attachingTabs.has(tabId)) return;
    if (captureMode === CAPTURE_MODE_CURRENT && !await isCurrentTab(tabId)) return;
    attachingTabs.add(tabId);
    try {
      await debuggerAttach(tabId);
      await sendCommand(tabId, "Fetch.enable", {
        patterns: [{ urlPattern: `*doubao.com${CHAIN_PATH}*`, requestStage: "Response" }]
      });
      attachedTabs.add(tabId);
      tabErrors.delete(tabId);
      await setBadge(tabId, "ON", "#16a34a");
    } catch (error) {
      tabErrors.set(tabId, debuggerErrorMessage(error));
      await setBadge(tabId, "ERR", "#dc2626");
    } finally {
      attachingTabs.delete(tabId);
    }
  }

  async function detachTab(tabId) {
    if (!attachedTabs.has(tabId) && !attachingTabs.has(tabId)) return;
    await new Promise((resolve) => {
      chrome.debugger.detach({ tabId }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
    attachedTabs.delete(tabId);
    attachingTabs.delete(tabId);
    await setBadge(tabId, "", "#71717a");
  }

  function debuggerAttach(tabId) {
    return new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, DEBUGGER_VERSION, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  }

  function sendCommand(tabId, method, params = {}) {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result || {});
      });
    });
  }

  async function handlePausedRequest(tabId, event) {
    const requestId = event.requestId;
    const url = event.request?.url || "";
    if (!isChainUrl(url) || !event.responseStatusCode) {
      await continueRequest(tabId, requestId);
      return;
    }

    let body = "";
    try {
      const response = await sendCommand(tabId, "Fetch.getResponseBody", { requestId });
      body = response.base64Encoded ? decodeBase64Utf8(response.body) : response.body;
      const tab = await safeGetTab(tabId);
      if (tab && body) await processChainBody(tab, body);
    } catch (error) {
      console.warn("[Doubao Original Video] 聊天响应解析失败", error);
    } finally {
      if (body) {
        await fulfillOriginalResponse(tabId, event, body).catch(() => continueRequest(tabId, requestId));
      } else {
        await continueRequest(tabId, requestId).catch(() => {});
      }
    }
  }

  function continueRequest(tabId, requestId) {
    return sendCommand(tabId, "Fetch.continueRequest", { requestId });
  }

  async function fulfillOriginalResponse(tabId, event, body) {
    await sendCommand(tabId, "Fetch.fulfillRequest", {
      requestId: event.requestId,
      responseCode: event.responseStatusCode || 200,
      responsePhrase: event.responseStatusText || "OK",
      responseHeaders: responseHeadersForBody(event.responseHeaders || [], body),
      body: encodeBase64Utf8(body)
    });
  }

  async function processChainBody(tab, body) {
    if (!isConcreteChatTab(tab)) return;
    if (captureMode === CAPTURE_MODE_CURRENT && !await isCurrentTab(tab.id)) return;
    let json;
    try { json = JSON.parse(body); } catch (_) { return; }
    const entries = findFallbackEntries(json, body).slice(0, MAX_CAPTURED_PER_RESPONSE);
    if (!entries.length) return;
    const meta = conversationMeta(tab);
    const resolved = await mapConcurrent(entries, 3, async (entry) => {
      const media = await resolveFallbackVideo(entry.url);
      if (!media.url) return null;
      return persistResolvedVideo(meta, entry, media);
    });
    const count = resolved.filter(Boolean).length;
    if (!count) return;
    await enforceSharedCachePolicy();
    for (const video of resolved.filter(Boolean)) {
      chrome.tabs.sendMessage(tab.id, { type: "DOUBAO_SESSION_VIDEO", video }, () => void chrome.runtime.lastError);
    }
    notify({ type: "GALLERY_UPDATED", media_type: "video", count });
  }

  async function persistResolvedVideo(meta, entry, media) {
    const videoId = media.video_id || videoIdFromUrl(entry.url) || hashText(entry.url);
    const recordId = sanitizeId(`${meta.chat_id}_${entry.message_id || "unknown"}_${entry.media_index}_${videoId}`);
    const existing = await getVideo(recordId);
    let thumbnailBlob = existing?.thumbnail_blob || null;
    if (!thumbnailBlob && media.poster_url) {
      thumbnailBlob = await fetchPosterThumbnail(media.poster_url).catch(() => null);
    }
    const record = {
      ...existing,
      video_record_id: recordId,
      video_id: videoId,
      message_id: entry.message_id,
      message_media_index: entry.media_index,
      fallback_api: entry.url,
      url: media.url,
      poster_url: media.poster_url || existing?.poster_url || "",
      thumbnail_blob: thumbnailBlob,
      width: media.width,
      height: media.height,
      bitrate: media.bitrate,
      size: media.size,
      format: media.format || "mp4",
      definition: media.definition || "",
      captured_at: existing?.captured_at || Date.now(),
      updated_at: Date.now(),
      conversation_id: existing?.conversation_id && existing.conversation_id !== "legacy"
        ? existing.conversation_id
        : meta.conversation_id,
      conversation_chat_id: existing?.conversation_chat_id || meta.chat_id,
      conversation_title: pickConversationTitle(existing?.conversation_title, meta.title),
      page_url: existing?.page_url || meta.page_url
    };
    await saveVideo(record);
    return record;
  }

  async function refreshStoredVideo(value) {
    const record = normalizeVideoRecord(value);
    if (!record) throw new Error("视频记录无效");
    const media = await resolveFallbackVideo(record.fallback_api);
    if (!media.url) throw new Error("未解析到无水印视频地址，请重新打开对应会话后重试");
    const updated = {
      ...record,
      url: media.url,
      poster_url: media.poster_url || record.poster_url,
      width: media.width || record.width,
      height: media.height || record.height,
      bitrate: media.bitrate || record.bitrate,
      size: media.size || record.size,
      format: media.format || record.format,
      definition: media.definition || record.definition,
      updated_at: Date.now()
    };
    await saveVideo(updated);
    return updated;
  }

  function findFallbackEntries(json, rawBody) {
    const results = [];
    const seen = new WeakSet();
    function walk(value, inheritedMessageId = "") {
      if (value == null) return;
      if (typeof value === "string") {
        if ((value.includes("fallback_api") || value.startsWith("{")) && value.length < 2_000_000) {
          try { walk(JSON.parse(value), inheritedMessageId); } catch (_) {}
        }
        return;
      }
      if (typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      const messageId = directMessageId(value) || inheritedMessageId;
      if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "fallback_api")) {
        const values = Array.isArray(value.fallback_api) ? value.fallback_api : [value.fallback_api];
        for (const candidate of values) addFallback(results, candidate, messageId);
      }
      for (const child of Object.values(value)) walk(child, messageId);
    }
    walk(json);
    for (const pattern of [/fallback_api\\":\\"(.*?)\\"/g, /"fallback_api"\s*:\s*"([^"]+)"/g]) {
      let match;
      while ((match = pattern.exec(rawBody))) addFallback(results, decodeEscaped(match[1]), "");
    }
    const counters = new Map();
    return results.map((entry) => {
      const key = entry.message_id || "unscoped";
      const mediaIndex = counters.get(key) || 0;
      counters.set(key, mediaIndex + 1);
      return { ...entry, media_index: mediaIndex };
    });
  }

  function addFallback(results, value, messageId) {
    if (typeof value !== "string") return;
    const url = decodeEscaped(value);
    if (!isAllowedFallbackUrl(url)) return;
    const scopedId = String(messageId || "");
    if (!scopedId) {
      if (!results.some((item) => item.url === url)) results.push({ url, message_id: "" });
      return;
    }
    const unscoped = results.find((item) => item.url === url && !item.message_id);
    if (unscoped) {
      unscoped.message_id = scopedId;
      return;
    }
    if (!results.some((item) => item.url === url && item.message_id === scopedId)) {
      results.push({ url, message_id: scopedId });
    }
  }

  function directMessageId(value) {
    for (const key of ["message_id", "msg_id", "messageId", "messageID"]) {
      const candidate = value?.[key];
      if ((typeof candidate === "string" || typeof candidate === "number") && String(candidate).trim()) {
        return String(candidate).trim();
      }
    }
    return "";
  }

  async function resolveFallbackVideo(fallbackApi) {
    if (!isAllowedFallbackUrl(fallbackApi)) return emptyMedia();
    try {
      const requestUrl = replaceQueryParams(fallbackApi, {
        channel: "no",
        codec_type: "8",
        logo_type: "unwatermarked"
      });
      const response = await fetch(requestUrl, {
        method: "GET",
        credentials: "omit",
        headers: { accept: "application/json,text/plain,*/*" }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const data = getVideoData(payload);
      const entry = pickHighestQuality(data);
      const url = entry.token ? await decodeMainUrl(entry.token, findKeySeed(payload)) : "";
      if (!isHttpUrl(url)) return emptyMedia();
      return {
        url,
        poster_url: findPosterUrl(payload),
        width: entry.width,
        height: entry.height,
        bitrate: entry.bitrate,
        size: entry.size,
        format: entry.format,
        definition: entry.definition,
        video_id: entry.videoId || videoIdFromUrl(fallbackApi)
      };
    } catch (error) {
      console.warn("[Doubao Original Video] 无水印地址解析失败", error.message);
      return emptyMedia();
    }
  }

  function getVideoData(payload) {
    const info = payload?.video_info || payload?.data?.video_info || payload;
    return info?.data || info || {};
  }

  function pickHighestQuality(data) {
    const list = data?.video_list;
    const values = list && typeof list === "object" && Object.keys(list).length ? Object.values(list) : [data];
    let best = null;
    for (const value of values) {
      if (!value || typeof value !== "object") continue;
      const token = value.main_url || value.play_url || "";
      if (typeof token !== "string" || !token.trim()) continue;
      const candidate = {
        token: token.trim(),
        width: Number(value.vwidth || value.width || 0),
        height: Number(value.vheight || value.height || 0),
        bitrate: Number(value.real_bitrate || value.bitrate || 0),
        size: Number(value.size || 0),
        format: String(value.vtype || value.format || "mp4"),
        definition: String(value.definition || value.quality || ""),
        videoId: String(value.file_id || data.video_id || "")
      };
      if (!best || higherQuality(candidate, best)) best = candidate;
    }
    return best || { token: "", width: 0, height: 0, bitrate: 0, size: 0, format: "mp4", definition: "", videoId: "" };
  }

  function higherQuality(a, b) {
    const pixelsA = a.width * a.height;
    const pixelsB = b.width * b.height;
    return pixelsA !== pixelsB ? pixelsA > pixelsB : a.bitrate > b.bitrate;
  }

  function findKeySeed(value, depth = 0, seen = new WeakSet()) {
    if (depth > 12 || value == null) return "";
    if (typeof value === "string") {
      const query = value.match(/(?:^|[?&])key_seed=([^&"'<>\\\s]+)/i);
      if (query) return safeDecodeURIComponent(query[1]);
      const json = value.match(/["']key_seed["']\s*:\s*["']([^"']+)/i);
      return json ? safeDecodeURIComponent(json[1]) : "";
    }
    if (typeof value !== "object" || seen.has(value)) return "";
    seen.add(value);
    if (typeof value.key_seed === "string" && value.key_seed.trim()) return value.key_seed.trim();
    for (const child of Object.values(value)) {
      const found = findKeySeed(child, depth + 1, seen);
      if (found) return found;
    }
    return "";
  }

  function findPosterUrl(value, depth = 0, seen = new WeakSet()) {
    if (depth > 10 || value == null || typeof value !== "object" || seen.has(value)) return "";
    seen.add(value);
    for (const key of ["poster_url", "cover_url", "posterUrl", "coverUrl"]) {
      if (typeof value[key] === "string" && isHttpUrl(value[key])) return value[key];
    }
    for (const child of Object.values(value)) {
      const found = findPosterUrl(child, depth + 1, seen);
      if (found) return found;
    }
    return "";
  }

  async function _loadOpaqueSalt() {
    if (_opaqueSaltHex) return _opaqueSaltHex;
    if (typeof resolveOpaqueSaltHex !== "function") throw new Error("opaque resolver missing");
    _opaqueSaltHex = await resolveOpaqueSaltHex();
    return _opaqueSaltHex;
  }

  async function decodeMainUrl(token, keySeed) {
    if (isHttpUrl(token)) return token;
    const plain = base64DecodeLoose(token);
    if (plain) {
      const text = asciiUrl(plain);
      if (isHttpUrl(text)) return text;
    }
    return token.startsWith("qAAB") && keySeed ? _decodeWrappedMediaToken(token, keySeed) : "";
  }

  async function _decodeWrappedMediaToken(token, keySeed) {
    const data = base64DecodeLoose(token);
    const seed = base64DecodeLoose(keySeed);
    if (!data || !seed) return "";
    const saltHex = await _loadOpaqueSalt();
    const digest1 = new Uint8Array(await crypto.subtle.digest("SHA-512", seed.slice(0, 32)));
    const digest2 = new Uint8Array(await crypto.subtle.digest(
      "SHA-512", concatBytes(digest1, hexToBytes(saltHex))
    ));
    const key = digest2.slice(0, 16);
    const iv = digest2.slice(16, 32);
    const attempts = [];
    if (data.length >= 4 && data[0] === 0xa8 && data[1] === 0 && data[2] === 1 && data[3] === 0) {
      attempts.push({ payload: data.slice(4), key, iv });
      attempts.push({ payload: data.slice(4), key: iv, iv: key });
      if (data.length > 36) {
        attempts.push({ payload: data.slice(36), key, iv: data.slice(20, 36) });
        attempts.push({ payload: data.slice(36), key, iv });
      }
    } else {
      attempts.push({ payload: data, key, iv });
    }
    for (const attempt of attempts) {
      const url = await decryptAesCbc(attempt.payload, attempt.key, attempt.iv);
      if (url) return url;
    }
    return "";
  }

  async function decryptAesCbc(payload, keyBytes, ivBytes) {
    if (!payload.length || payload.length % 16 !== 0) return "";
    try {
      const key = await crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["decrypt"]);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBytes }, key, payload));
      const direct = asciiUrl(plain);
      if (isHttpUrl(direct)) return direct;
      const stripped = asciiUrl(stripPkcs7(plain));
      return isHttpUrl(stripped) ? stripped : "";
    } catch (_) { return ""; }
  }

  async function fetchPosterThumbnail(url) {
    const response = await fetch(url, { credentials: "omit", cache: "force-cache" });
    if (!response.ok) throw new Error(`封面请求失败：${response.status}`);
    const blob = await response.blob();
    if (!blob.type.startsWith("image/") || blob.size > 20 * 1024 * 1024) throw new Error("封面格式无效");
    const bitmap = await createImageBitmap(blob);
    try {
      const size = 160;
      const canvas = new OffscreenCanvas(size, size);
      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#18181b";
      context.fillRect(0, 0, size, size);
      const scale = Math.max(size / bitmap.width, size / bitmap.height);
      const width = bitmap.width * scale;
      const height = bitmap.height * scale;
      context.drawImage(bitmap, (size - width) / 2, (size - height) / 2, width, height);
      return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
    } finally { bitmap.close(); }
  }

  function enqueueVideoDownloads(videos) {
    for (const video of videos) {
      const key = video.video_record_id;
      if (queuedDownloadKeys.has(key)) continue;
      queuedDownloadKeys.add(key);
      downloadQueue.push({ key, video });
    }
    pumpVideoDownloads();
  }

  function pumpVideoDownloads() {
    while (activeDownloads < DOWNLOAD_CONCURRENCY && downloadQueue.length) {
      const job = downloadQueue.shift();
      activeDownloads += 1;
      runVideoDownload(job.video)
        .catch((error) => notify({
          type: "VIDEO_DOWNLOAD_FAILED",
          video_record_id: job.video.video_record_id,
          error: error.message
        }))
        .finally(() => {
          queuedDownloadKeys.delete(job.key);
          activeDownloads -= 1;
          pumpVideoDownloads();
        });
    }
  }

  async function runVideoDownload(video) {
    let lastError = new Error("视频下载失败");
    for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
      try {
        const media = await resolveFallbackVideo(video.fallback_api);
        const url = media.url || video.url;
        if (!isHttpUrl(url)) throw new Error("无水印视频地址已失效");
        notify({
          type: attempt > 1 ? "VIDEO_DOWNLOAD_RETRYING" : "VIDEO_DOWNLOAD_STARTED",
          video_record_id: video.video_record_id,
          attempt,
          max_attempts: MAX_DOWNLOAD_ATTEMPTS
        });
        const downloadId = await startChromeDownload({
          url,
          filename: buildVideoFilename(video, media),
          conflictAction: "uniquify",
          saveAs: false
        });
        const result = await waitForDownload(downloadId);
        if (result.state === "complete") {
          notify({ type: "VIDEO_DOWNLOAD_COMPLETE", video_record_id: video.video_record_id, attempts: attempt });
          return;
        }
        throw new Error(result.error || "下载被中断");
      } catch (error) {
        lastError = error;
        if (attempt < MAX_DOWNLOAD_ATTEMPTS) await delay(700 * attempt);
      }
    }
    throw lastError;
  }

  function startChromeDownload(options) {
    return new Promise((resolve, reject) => {
      chrome.downloads.download(options, (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      });
    });
  }

  function waitForDownload(downloadId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish({ state: "interrupted", error: "下载超时" }), DOWNLOAD_TIMEOUT_MS);
      function finish(result) {
        if (!downloadWaiters.has(downloadId)) return;
        clearTimeout(timer);
        downloadWaiters.delete(downloadId);
        resolve(result);
      }
      downloadWaiters.set(downloadId, { finish });
    });
  }

  function buildVideoFilename(video, media) {
    const chat = sanitizeFilename(video.conversation_chat_id || "chat").slice(-30);
    const id = sanitizeFilename(video.video_id || "video").slice(-80);
    const extension = detectVideoExtension(media.url || video.url, media.format || video.format);
    return `doubao_original_media/${chat}/${id}.${extension}`;
  }

  function detectVideoExtension(url, format) {
    const normalized = String(format || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (VIDEO_EXTENSIONS.has(normalized)) return normalized;
    try {
      const match = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
      if (match && VIDEO_EXTENSIONS.has(match[1].toLowerCase())) return match[1].toLowerCase();
    } catch (_) {}
    return "mp4";
  }

  function normalizeVideoRecord(value) {
    if (!value || typeof value !== "object" || !isAllowedFallbackUrl(value.fallback_api)) return null;
    return {
      video_record_id: sanitizeId(value.video_record_id || hashText(value.fallback_api)),
      video_id: String(value.video_id || videoIdFromUrl(value.fallback_api) || "video").slice(0, 200),
      message_id: String(value.message_id || "").slice(0, 200),
      message_media_index: Number(value.message_media_index || 0),
      fallback_api: value.fallback_api,
      url: isHttpUrl(value.url) ? value.url : "",
      poster_url: isHttpUrl(value.poster_url) ? value.poster_url : "",
      thumbnail_blob: value.thumbnail_blob instanceof Blob ? value.thumbnail_blob : null,
      width: Number(value.width || 0),
      height: Number(value.height || 0),
      bitrate: Number(value.bitrate || 0),
      size: Number(value.size || 0),
      format: String(value.format || "mp4").slice(0, 20),
      definition: String(value.definition || "").slice(0, 50),
      captured_at: Number(value.captured_at || Date.now()),
      updated_at: Number(value.updated_at || Date.now()),
      conversation_id: String(value.conversation_id || "legacy").slice(0, 500),
      conversation_chat_id: String(value.conversation_chat_id || "").slice(0, 200),
      conversation_title: String(value.conversation_title || "未分类历史").slice(0, 150),
      page_url: String(value.page_url || "").slice(0, 1000)
    };
  }

  function conversationMeta(tab) {
    const url = new URL(tab.url);
    const match = url.pathname.match(/\/(?:chat|conversation)\/([^/?#]+)/i);
    const chatId = match?.[1] || url.searchParams.get("chat_id") || url.searchParams.get("conversation_id") || "";
    let title = String(tab.title || "")
      .replace(/\s*[-|｜]\s*豆包.*$/i, "")
      .replace(/^豆包\s*[-|｜]?\s*/i, "")
      .replace(/字节跳动旗下.*$/i, "")
      .trim();
    if (!title || title === "豆包" || /智能助手/i.test(title)) {
      title = chatId && chatId.length >= 10 ? `对话 ${chatId.slice(-10)}` : "未进入会话";
    }
    return {
      conversation_id: `${url.origin}:${chatId || "home"}`,
      chat_id: chatId || "home",
      title: title.slice(0, 120),
      page_url: `${url.origin}${url.pathname}`
    };
  }

  function isConcreteChatTab(tab) {
    try {
      const meta = conversationMeta(tab);
      const id = String(meta.chat_id || "");
      return id.length >= 10 && !/^(home|chat|conversation|new|index|explore|discover|bot|agent)$/i.test(id);
    } catch (_) {
      return false;
    }
  }

  async function enforceSharedCachePolicy() {
    const stored = await storageGet({ cacheLimitMb: 100, cacheMaxItems: 1000 });
    const maxMb = Math.min(1000, Math.max(25, Number(stored.cacheLimitMb) || 100));
    const maxItems = Math.min(10000, Math.max(100, Number(stored.cacheMaxItems) || 1000));
    await pruneCache(maxMb * 1024 * 1024, maxItems);
  }

  function isTargetPage(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && hostMatches(url.hostname, "doubao.com");
    } catch (_) { return false; }
  }

  function isChainUrl(value) {
    try {
      const url = new URL(value);
      return isTargetPage(value) && (url.pathname === CHAIN_PATH || url.pathname === `${CHAIN_PATH}/`);
    } catch (_) { return false; }
  }

  function isAllowedFallbackUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && FALLBACK_HOSTS.some((host) => hostMatches(url.hostname, host));
    } catch (_) { return false; }
  }

  function hostMatches(hostname, suffix) {
    const host = String(hostname || "").toLowerCase();
    return host === suffix || host.endsWith(`.${suffix}`);
  }

  function replaceQueryParams(value, params) {
    const url = new URL(value);
    for (const [key, item] of Object.entries(params)) url.searchParams.set(key, item);
    return url.href;
  }

  function videoIdFromUrl(value) {
    try {
      const parts = new URL(value).pathname.split("/").filter(Boolean).reverse();
      return parts.find((part) => /^v[a-z0-9]{12,}$/i.test(part)) || "";
    } catch (_) { return ""; }
  }

  function decodeEscaped(value) {
    let text = String(value || "");
    for (let index = 0; index < 3; index += 1) {
      try {
        const decoded = JSON.parse(`"${text.replace(/"/g, '\\"')}"`);
        if (decoded === text) break;
        text = decoded;
      } catch (_) { break; }
    }
    return text.replace(/\\u0026/gi, "&").replace(/\\\//g, "/");
  }

  function base64DecodeLoose(value) {
    const input = String(value || "").trim();
    const variants = [
      input,
      input.replace(/[$@#]/g, (char) => ({ "$": "_", "@": "/", "#": "." }[char])),
      input.replace(/[$@#]/g, (char) => ({ "$": "+", "@": "/", "#": "=" }[char]))
    ];
    for (const candidate of new Set(variants)) {
      if (!candidate) continue;
      try {
        const normalized = candidate.replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
        const binary = atob(padded);
        return Uint8Array.from(binary, (char) => char.charCodeAt(0));
      } catch (_) {}
    }
    return null;
  }

  function asciiUrl(bytes) {
    if (!bytes?.length) return "";
    for (const byte of bytes) {
      if (byte !== 9 && byte !== 10 && byte !== 13 && (byte < 32 || byte > 126)) return "";
    }
    return new TextDecoder().decode(bytes).replace(/\0+$/g, "").trim();
  }

  function stripPkcs7(bytes) {
    const size = bytes[bytes.length - 1];
    if (!size || size > 16 || size > bytes.length) return bytes;
    for (let index = bytes.length - size; index < bytes.length; index += 1) if (bytes[index] !== size) return bytes;
    return bytes.slice(0, bytes.length - size);
  }

  function hexToBytes(value) {
    const bytes = new Uint8Array(value.length / 2);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(value.slice(index * 2, index * 2 + 2), 16);
    return bytes;
  }

  function concatBytes(...values) {
    const output = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
    let offset = 0;
    for (const value of values) {
      output.set(value, offset);
      offset += value.length;
    }
    return output;
  }

  function responseHeadersForBody(headers, body) {
    const blocked = new Set(["content-length", "content-encoding", "transfer-encoding"]);
    const result = headers.filter((header) => !blocked.has(String(header.name || "").toLowerCase()));
    result.push({ name: "content-length", value: String(new TextEncoder().encode(body).length) });
    return result;
  }

  function encodeBase64Utf8(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function decodeBase64Utf8(value) {
    return new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0)));
  }

  function emptyMedia() {
    return { url: "", poster_url: "", width: 0, height: 0, bitrate: 0, size: 0, format: "mp4", definition: "", video_id: "" };
  }

  function isHttpUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch (_) { return false; }
  }

  function sanitizeId(value) {
    return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").slice(0, 220);
  }

  function sanitizeFilename(value) {
    return String(value || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim() || "video";
  }

  function hashText(value) {
    let hash = 2166136261;
    for (const char of String(value || "")) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function safeDecodeURIComponent(value) {
    try { return decodeURIComponent(value); } catch (_) { return value; }
  }

  function mapConcurrent(values, concurrency, worker) {
    const results = new Array(values.length);
    let cursor = 0;
    async function run() {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await worker(values[index], index);
      }
    }
    return Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run)).then(() => results);
  }

  function activeTab() {
    return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => tabs[0] || null);
  }

  async function isCurrentTab(tabId) {
    const tab = await activeTab();
    return tab?.id === tabId;
  }

  function safeGetTab(tabId) {
    return new Promise((resolve) => chrome.tabs.get(tabId, (tab) => resolve(chrome.runtime.lastError ? null : tab)));
  }

  function setBadge(tabId, text, color) {
    return Promise.all([
      chrome.action.setBadgeText({ tabId, text }),
      chrome.action.setBadgeBackgroundColor({ tabId, color })
    ]).catch(() => {});
  }

  function debuggerErrorMessage(error) {
    const message = error instanceof Error ? error.message : String(error || "未知错误");
    return /Another debugger|already attached|Cannot access/i.test(message)
      ? "请关闭当前豆包标签页的普通 F12 或其他视频去水印扩展后重试"
      : message;
  }

  function storageGet(defaults) {
    return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
  }

  function notify(message) {
    try { chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError); } catch (_) {}
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  syncTargetTabs().catch((error) => console.warn("[Doubao Original Video] 初始化连接失败", error));
})();
