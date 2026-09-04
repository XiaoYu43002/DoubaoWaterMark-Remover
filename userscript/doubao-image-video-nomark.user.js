// ==UserScript==
// @name              豆包图片视频去水印
// @name:zh-CN        豆包图片视频去水印
// @namespace         https://github.com/XiaoYu43002/DoubaoWaterMark-Remover
// @version           1.3.0
// @description       自动识别豆包当前会话生成的图片和视频，获取无水印原始媒体并支持单项或批量下载。所有数据仅在浏览器本地处理。
// @description:zh-CN 自动识别豆包当前会话生成的图片和视频，获取无水印原始媒体并支持单项或批量下载。所有数据仅在浏览器本地处理。
// @author            十一木
// @license           GPL-3.0-or-later
// @supportURL        https://github.com/XiaoYu43002/DoubaoWaterMark-Remover/issues
// @homepageURL       https://github.com/XiaoYu43002/DoubaoWaterMark-Remover
// @icon              https://s1.mnat.cn/2026/09/04/6a9a86ff64008.png
// @icon64            https://s1.mnat.cn/2026/09/04/6a9a86ff64008.png
// @match             https://www.doubao.com/*
// @match             https://*.doubao.com/*
// @run-at            document-start
// @grant             unsafeWindow
// @grant             GM_download
// @grant             GM_xmlhttpRequest
// @grant             GM_registerMenuCommand
// @connect           byteimg.com
// @connect           *.byteimg.com
// @connect           douyinpic.com
// @connect           *.douyinpic.com
// @connect           doubao.com
// @connect           *.doubao.com
// @connect           snssdk.com
// @connect           *.snssdk.com
// @connect           byteintlapi.com
// @connect           *.byteintlapi.com
// @connect           douyin.com
// @connect           *.douyin.com
// @noframes
// ==/UserScript==

(() => {
    "use strict";
  
    const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  
    if (pageWindow.__DOUBAO_IMAGE_USERSCRIPT_HOOK__) return;
    pageWindow.__DOUBAO_IMAGE_USERSCRIPT_HOOK__ = true;
  
    const MESSAGE_IMAGES = "DOUBAO_USERSCRIPT_IMAGES";
    const MESSAGE_STATUS = "DOUBAO_USERSCRIPT_STATUS";
    const MESSAGE_READY = "DOUBAO_USERSCRIPT_BRIDGE_READY";
    const MESSAGE_VIDEO_FALLBACKS = "DOUBAO_USERSCRIPT_VIDEO_FALLBACKS";
    const records = new Map();
    const rawUrlIndex = new Map();
    const assetKeyIndex = new Map();
    const originalParse = pageWindow.JSON.parse;
    const videoFallbackKeys = new Set();
    let captureCount = 0;
    let lastFiberScanAt = 0;
    let fiberIdleHandle = null;
    let pendingFiberForce = false;
    let extensionEnabled = true;
  
    function safeUrl(value) {
      if (typeof value !== "string" || value.length > 8192) return null;
      try {
        const url = new URL(value, pageWindow.location.href);
        return url.protocol === "https:" ? url.href : null;
      } catch (_) {
        return null;
      }
    }
  
    function absoluteHttpsUrl(value) {
      if (typeof value !== "string" || !/^https:\/\//i.test(value.trim())) return "";
      try {
        const url = new URL(value.trim());
        return url.protocol === "https:" ? url.href : "";
      } catch (_) {
        return "";
      }
    }
  
    function urlFrom(value) {
      if (typeof value === "string") return safeUrl(value);
      if (value && typeof value === "object") return safeUrl(value.url);
      return null;
    }
  
    function stableIdFromUrl(value) {
      const safe = safeUrl(value);
      if (!safe) return null;
      try {
        const url = new URL(safe);
        return decodeURIComponent(url.pathname)
          .replace(/\.(?:jpe?g|png|webp|avif|gif)$/i, "")
          .replace(/[^a-zA-Z0-9_-]+/g, "_")
          .slice(-180) || url.hostname;
      } catch (_) {
        return safe.split(/[?#]/)[0];
      }
    }
  
    function looksLikeNoiseImage(obj) {
      if (!obj || typeof obj !== "object") return true;
      // 搜索结果、网页引用、文档/附件截图等不是 AI 生成图。
      if (
        obj.source_url || obj.site_name || obj.favicon || obj.favicon_url ||
        obj.search_id || obj.doc_id || obj.webpage_id || obj.reference_type ||
        obj.card_type || obj.outline || obj.snippet || obj.cite_id
      ) return true;
      const hint = [
        obj.media_type, obj.mime_type, obj.type, obj.image_type,
        obj.skill, obj.skill_type, obj.content_type, obj.scene
      ].map((value) => String(value || "").toLowerCase()).join(" ");
      if (/video|mp4|webm|mov|avatar|icon|emoji|sticker|logo|qr|profile|search|doc|pdf|webpage|reference|cite|attachment|file|screenshot|ocr/.test(hint)) {
        return true;
      }
      if (obj.video_id || obj.video_info || obj.video_list) return true;
      if (obj.is_reference || obj.reference_image || obj.ref_image || obj.input_image) return true;
      return false;
    }
  
    function looksLikeReferencePayload(item) {
      if (!item || typeof item !== "object") return false;
      if (looksLikeNoiseImage(item)) return true;
      const hint = [
        item.role, item.reference_type, item.attachment_type, item.input_type,
        item.source_type, item.scene, item.type, item.content_type, item.media_type
      ].map((value) => String(value || "").toLowerCase()).join(" ");
      return /reference|attach|input|upload|compose|draft|pending|ref_?image|user_image|quote/.test(hint);
    }
  
    function assetKeyFromUrl(value) {
      if (typeof value !== "string" || !value) return "";
      try {
        const url = new URL(value);
        if (url.protocol !== "https:") return "";
        let path = decodeURIComponent(url.pathname);
        path = path.replace(/~[^/]+$/i, "");
        path = path.replace(/\.(?:jpe?g|png|webp|avif|gif)$/i, "");
        return path.toLowerCase();
      } catch (_) {
        return "";
      }
    }
  
    function assetKeysFromCandidate(record) {
      const keys = new Set();
      for (const url of [
        record?.image_ori_raw_url,
        record?.image_ori_url,
        record?.image_preview_url,
        record?.image_thumb_url,
        record?.best_url
      ]) {
        const key = assetKeyFromUrl(url);
        if (key) keys.add(key);
      }
      return keys;
    }
  
    function imageIdForAssetKey(key) {
      return key ? assetKeyIndex.get(key) || null : null;
    }
  
    function findExistingIdForCandidate(candidate) {
      const rawUrl = canonicalRawUrl(candidate);
      const byUrl = rawUrl ? imageIdForRawUrl(rawUrl) : null;
      if (byUrl) return byUrl;
      for (const key of assetKeysFromCandidate(candidate)) {
        const id = imageIdForAssetKey(key);
        if (id) return id;
      }
      return null;
    }
  
    function canonicalRawUrl(record) {
      return record?.image_ori_raw_url || record?.best_url || "";
    }
  
    function rememberRawUrl(record) {
      const rawUrl = canonicalRawUrl(record);
      if (rawUrl) rawUrlIndex.set(rawUrl, record.image_id);
      for (const key of assetKeysFromCandidate(record)) {
        assetKeyIndex.set(key, record.image_id);
      }
      return record;
    }
  
    function imageIdForRawUrl(rawUrl) {
      if (!rawUrl) return null;
      return rawUrlIndex.get(rawUrl) || null;
    }
  
    function extensionHint(url) {
      try {
        const match = decodeURIComponent(new URL(url).pathname).match(/\.([a-z0-9]{2,5})$/i);
        const ext = match?.[1]?.toLowerCase();
        if (!ext) return null;
        if (ext === "jpeg") return "jpg";
        return ["jpg", "png", "webp", "avif", "gif"].includes(ext) ? ext : null;
      } catch (_) {
        return null;
      }
    }
  
    function pickRecord(obj) {
      if (!obj || typeof obj !== "object" || looksLikeNoiseImage(obj)) return null;
  
      // 无水印原图字段是生成图的稳定信号；仅有 image_ori 的多为展示/引用图。
      const rawUrl = urlFrom(obj.image_ori_raw) || urlFrom(obj.image_raw);
      if (!rawUrl) return null;
      const oriUrl = urlFrom(obj.image_ori);
      const previewUrl = urlFrom(obj.image_preview);
      const thumbUrl = urlFrom(obj.image_thumb);
      const bestUrl = rawUrl || oriUrl || previewUrl || thumbUrl;
      if (!bestUrl) return null;
  
      const nested = [obj.image_ori_raw, obj.image_raw, obj.image_ori, obj.image_preview, obj.image_thumb]
        .find((value) => value && typeof value === "object") || {};
      const width = Number(
        obj.width || obj.image_width || obj.ori_width ||
        nested.width || nested.image_width || nested.ori_width || 0
      );
      const height = Number(
        obj.height || obj.image_height || obj.ori_height ||
        nested.height || nested.image_height || nested.ori_height || 0
      );
      if (width > 0 && height > 0) {
        const shortSide = Math.min(width, height);
        const longSide = Math.max(width, height);
        // 过滤细长截图、小图标和明显非生图尺寸。
        if (shortSide < 256 || longSide / shortSide > 2.6) return null;
      }
  
      const explicitId = obj.image_id || obj.creation_id || obj.key || obj.id;
      const imageId = typeof explicitId === "string" && explicitId.length < 200
        ? explicitId
        : stableIdFromUrl(bestUrl);
  
      if (!imageId) return null;
  
      return {
        image_id: imageId,
        image_ori_raw_url: rawUrl,
        image_ori_url: oriUrl,
        image_preview_url: previewUrl,
        image_thumb_url: thumbUrl,
        best_url: bestUrl,
        width: width > 0 ? width : 0,
        height: height > 0 ? height : 0,
        extension: extensionHint(rawUrl) || extensionHint(oriUrl) || extensionHint(previewUrl) || extensionHint(thumbUrl),
        captured_at: Date.now()
      };
    }
  
    function pickCreationImage(item) {
      if (!item || typeof item !== "object" || looksLikeReferencePayload(item)) return null;
      const image = item.image && typeof item.image === "object" ? item.image : item;
      return pickRecord(image);
    }
  
    function quality(record) {
      if (record.image_ori_raw_url) return 4;
      if (record.image_ori_url) return 3;
      if (record.image_preview_url) return 2;
      return record.image_thumb_url ? 1 : 0;
    }
  
    function replaceAssetUrl(asset, rawUrl) {
      if (!asset || typeof asset !== "object") return;
      if (typeof asset.url === "string") asset.url = rawUrl;
      if (typeof asset.uri === "string") asset.uri = rawUrl;
      if (typeof asset.main_url === "string") asset.main_url = rawUrl;
      if (Array.isArray(asset.url_list)) asset.url_list = [rawUrl];
      if (Array.isArray(asset.urls)) asset.urls = [rawUrl];
    }
  
    function upgradePageImageData(obj, rawUrl) {
      if (!obj || typeof obj !== "object" || !rawUrl) return;
  
      const assetKeys = [
        "image_ori",
        "image_preview",
        "image_thumb",
        "image_watermark",
        "image_download",
        "download_image",
        "preview_image"
      ];
  
      for (const key of assetKeys) {
        if (obj[key]) replaceAssetUrl(obj[key], rawUrl);
      }
  
      for (const key of Object.keys(obj)) {
        if (key === "image_ori_raw" || key === "image_raw") continue;
        const value = obj[key];
  
        if (/image|preview|watermark|download/i.test(key) && value && typeof value === "object") {
          replaceAssetUrl(value, rawUrl);
        }
  
        if (
          typeof value === "string" &&
          /(?:image|preview|watermark|download).*(?:url|uri)|^(?:url|uri)$/i.test(key) &&
          safeUrl(value)
        ) {
          obj[key] = rawUrl;
        }
      }
    }
  
    function mergeRecord(next) {
      const existingId = findExistingIdForCandidate(next);
      if (existingId) next.image_id = existingId;
  
      const previous = records.get(next.image_id);
      if (!previous) {
        records.set(next.image_id, next);
        rememberRawUrl(next);
        return next;
      }
  
      const merged = {
        ...previous,
        ...next,
        image_ori_raw_url: next.image_ori_raw_url || previous.image_ori_raw_url,
        image_ori_url: next.image_ori_url || previous.image_ori_url,
        image_preview_url: next.image_preview_url || previous.image_preview_url,
        image_thumb_url: next.image_thumb_url || previous.image_thumb_url,
        width: next.width || previous.width || 0,
        height: next.height || previous.height || 0,
        extension: next.extension || previous.extension || null,
        captured_at: Math.min(previous.captured_at, next.captured_at)
      };
      merged.best_url = merged.image_ori_raw_url || merged.image_ori_url ||
        merged.image_preview_url || merged.image_thumb_url;
      records.set(next.image_id, merged);
      rememberRawUrl(merged);
      return quality(merged) > quality(previous) ? merged : null;
    }
  
    function isConcreteChatPage() {
      try {
        const url = new URL(pageWindow.location.href);
        const pathMatch = url.pathname.match(/\/(?:chat|conversation)\/([^/?#]+)/i);
        const queryId = url.searchParams.get("conversation_id") || url.searchParams.get("conversationId") ||
          url.searchParams.get("chat_id") || url.searchParams.get("chatId");
        const id = String(queryId || pathMatch?.[1] || "").trim();
        if (!id || id.length < 10) return false;
        if (/^(home|chat|conversation|new|index|explore|discover|bot|agent)$/i.test(id)) return false;
        return /^[a-zA-Z0-9_-]+$/.test(id);
      } catch (_) {
        return false;
      }
    }
  
    function getPageChatId() {
      try {
        const url = new URL(pageWindow.location.href);
        const pathMatch = url.pathname.match(/\/(?:chat|conversation)\/([^/?#]+)/i);
        const queryId = url.searchParams.get("conversation_id") || url.searchParams.get("conversationId") ||
          url.searchParams.get("chat_id") || url.searchParams.get("chatId");
        return String(queryId || pathMatch?.[1] || "").trim();
      } catch (_) {
        return "";
      }
    }
  
    let boundChatId = getPageChatId();
  
    function syncInjectedChat() {
      const chatId = getPageChatId();
      if (chatId !== boundChatId) {
        records.clear();
        rawUrlIndex.clear();
        assetKeyIndex.clear();
        videoFallbackKeys.clear();
        boundChatId = chatId;
        captureCount = 0;
        pageWindow.postMessage({ type: "DOUBAO_USERSCRIPT_CHAT_CHANGED", chat_id: chatId }, pageWindow.location.origin);
        // 从首页进入新建会话时，URL 往往晚于首包出图；切到真实 chatId 后立刻补扫入库。
        if (isConcreteChatPage()) queueReactFiberScan(true);
      }
      return chatId;
    }
  
    function valueMentionsChat(value, chatId) {
      if (!chatId || value == null) return false;
      if (typeof value === "string" || typeof value === "number") {
        return String(value) === chatId;
      }
      return false;
    }
  
    function objectMatchesChat(obj, chatId) {
      if (!obj || typeof obj !== "object" || !chatId) return false;
      const keys = [
        "conversation_id", "conversationId", "chat_id", "chatId", "cid",
        "conversation_chat_id", "bot_conversation_id"
      ];
      for (const key of keys) {
        try {
          if (valueMentionsChat(obj[key], chatId)) return true;
        } catch (_) {}
      }
      return false;
    }
  
    function treeMentionsChat(root, chatId, budget = 2500) {
      if (!root || typeof root !== "object" || !chatId) return false;
      const visited = new WeakSet();
      const stack = [root];
      let inspected = 0;
      while (stack.length && inspected < budget) {
        const current = stack.pop();
        if (!current || typeof current !== "object" || visited.has(current)) continue;
        visited.add(current);
        inspected += 1;
        if (objectMatchesChat(current, chatId)) return true;
        if (Array.isArray(current)) {
          for (const value of current) {
            if (value && typeof value === "object") stack.push(value);
          }
          continue;
        }
        for (const key of Object.keys(current)) {
          try {
            const value = current[key];
            if (value && typeof value === "object") stack.push(value);
          } catch (_) {}
        }
      }
      return false;
    }
  
    function postImages(images) {
      if (!extensionEnabled) return;
      syncInjectedChat();
      if (!images.length || !isConcreteChatPage()) return;
      const chatId = boundChatId;
      const scoped = images.filter((item) => !item.page_chat_id || item.page_chat_id === chatId);
      if (!scoped.length) return;
      pageWindow.postMessage({ type: MESSAGE_IMAGES, images: scoped }, pageWindow.location.origin);
      pageWindow.postMessage({
        type: MESSAGE_STATUS,
        status: "captured",
        total: records.size,
        capture_count: captureCount
      }, pageWindow.location.origin);
    }
  
    function collectCreationImages(node, parentKey, chatId, found, budget = { left: 120 }) {
      if (!node || typeof node !== "object" || budget.left <= 0) return;
      if (Array.isArray(node)) {
        if (/creations/i.test(parentKey)) {
          for (const item of node) {
            if (budget.left <= 0) break;
            const candidate = pickCreationImage(item);
            if (!candidate) continue;
            candidate.page_chat_id = chatId;
            const existingId = findExistingIdForCandidate(candidate);
            if (existingId) {
              candidate.image_id = existingId;
              mergeRecord(candidate);
              if (candidate.image_ori_raw_url && item?.image) {
                upgradePageImageData(item.image, candidate.image_ori_raw_url);
              } else if (candidate.image_ori_raw_url) {
                upgradePageImageData(item, candidate.image_ori_raw_url);
              }
              continue;
            }
            const changed = mergeRecord(candidate);
            if (changed) {
              found.push(changed);
              budget.left -= 1;
            }
          }
        }
        for (const item of node) collectCreationImages(item, parentKey, chatId, found, budget);
        return;
      }
      for (const key of Object.keys(node)) {
        collectCreationImages(node[key], key, chatId, found, budget);
      }
    }
  
    function scanCreationsOnly(root, chatId) {
      const found = [];
      collectCreationImages(root, "", chatId, found);
      postImages(found.slice(0, 200));
      return found.length;
    }
  
    function canPersistUnscopedPayload(text, chatId) {
      if (!text || !chatId) return false;
      if (!text.includes("creations") || !text.includes("image_ori_raw")) return false;
      // 大包/历史同步常含其它会话 ID 或分页字段，不能无会话标记入库。
      if (text.length > 180000) return false;
      if (/message_list|has_more|conversation_list|history_message|recent_chat/i.test(text)) return false;
      const foreignIds = (text.match(/\d{17,20}/g) || []).filter((id) => id !== chatId);
      return foreignIds.length === 0;
    }
  
    function scanObject(root, maxInspected = 9000, options = {}) {
      if (!extensionEnabled) return 0;
      if (!root || typeof root !== "object") return 0;
      syncInjectedChat();
      const chatId = boundChatId;
      const persist = options.persist !== false;
      const forcePost = Boolean(options.forcePost);
      // 响应里必须能定位到当前会话 ID，才允许入库；否则只可能是其它接口的图。
      const wantScope = options.requireChatScope !== false && Boolean(chatId) && persist;
      const hasChatMarker = wantScope ? treeMentionsChat(root, chatId) : false;
      if (persist && wantScope && !hasChatMarker) return 0;
      const requireChatScope = wantScope && hasChatMarker;
      const found = [];
      const visited = new WeakSet();
      const stack = [{ value: root, inScope: !requireChatScope }];
      let inspected = 0;
  
      while (stack.length && inspected < maxInspected) {
        const currentFrame = stack.pop();
        const current = currentFrame.value;
        if (!current || typeof current !== "object" || visited.has(current)) continue;
        visited.add(current);
        inspected += 1;
  
        const inScope = currentFrame.inScope || objectMatchesChat(current, chatId);
  
        // 优先从 creations 数组提取真正的 AI 生成图。
        if (inScope && Array.isArray(current)) {
          let creationHits = 0;
          for (const item of current) {
            const candidate = pickCreationImage(item);
            if (!candidate) continue;
            candidate.page_chat_id = chatId;
            const existingId = findExistingIdForCandidate(candidate);
            if (existingId) {
              candidate.image_id = existingId;
              mergeRecord(candidate);
              if (candidate.image_ori_raw_url && item?.image) {
                upgradePageImageData(item.image, candidate.image_ori_raw_url);
              } else if (candidate.image_ori_raw_url) {
                upgradePageImageData(item, candidate.image_ori_raw_url);
              }
              creationHits += 1;
              continue;
            }
            const changed = mergeRecord(candidate);
            if (persist) {
              if (changed) found.push(changed);
              else if (forcePost) found.push(records.get(candidate.image_id) || candidate);
            }
            if (candidate.image_ori_raw_url && item?.image) {
              upgradePageImageData(item.image, candidate.image_ori_raw_url);
            } else if (candidate.image_ori_raw_url) {
              upgradePageImageData(item, candidate.image_ori_raw_url);
            }
            creationHits += 1;
          }
          if (creationHits) continue;
        }
  
        if (inScope) {
          const candidate = pickRecord(current);
          if (candidate) {
            candidate.page_chat_id = chatId;
            const changed = mergeRecord(candidate);
            if (persist) {
              if (changed) found.push(changed);
              else if (forcePost) found.push(records.get(candidate.image_id) || candidate);
            }
            if (candidate.image_ori_raw_url) {
              upgradePageImageData(current, candidate.image_ori_raw_url);
            }
          }
        }
  
        const priority = [];
        const fallback = [];
        const entries = Array.isArray(current)
          ? current.map((value, index) => [String(index), value])
          : Object.keys(current).map((key) => [key, current[key]]);
        for (const [key, value] of entries) {
          try {
            if (!value || typeof value !== "object") continue;
            if (/creation|image|media|content|message|answer|item|data|response|result|conversation/i.test(key)) {
              priority.push(value);
            } else fallback.push(value);
          } catch (_) {
            // 页面对象的个别 getter 可能抛错，忽略该字段。
          }
        }
        for (const value of fallback) stack.push({ value, inScope });
        for (const value of priority) stack.push({ value, inScope });
      }
  
      if (persist) postImages(found.slice(0, 200));
      return found.length;
    }
  
    function isComposerOrInputImage(img) {
      if (!img?.isConnected) return false;
      if (img.closest([
        "footer",
        "form",
        '[class*="composer" i]',
        '[class*="input" i]',
        '[class*="editor" i]',
        '[class*="textarea" i]',
        '[class*="prompt" i]',
        '[data-testid*="composer" i]',
        '[data-testid*="input" i]',
        '[aria-label*="输入" i]',
        '[placeholder*="输入" i]'
      ].join(","))) {
        return true;
      }
      const rect = img.getBoundingClientRect();
      return rect.bottom > pageWindow.innerHeight * 0.72 && rect.height < 220;
    }
  
    function shouldPersistFiberImage(img) {
      return isLikelyConversationImage(img) && !isComposerOrInputImage(img);
    }
  
    function scanReactFiber(force = false) {
      if (!isConcreteChatPage()) return;
      syncInjectedChat();
      if (!force && Date.now() - lastFiberScanAt < 2000) return;
      lastFiberScanAt = Date.now();
  
      const images = Array.from(document.querySelectorAll('img[src*="byteimg.com"], img[srcset*="byteimg.com"]'))
        .filter(isLikelyConversationImage);
      const scannedReactValues = new WeakSet();
      let scannedTargets = 0;
  
      for (const img of images) {
        if (scannedTargets >= 10) break;
        let node = img;
        let imageScanned = false;
        const allowPersist = shouldPersistFiberImage(img);
  
        // Fiber 负责替换水印；仅会话主区图片入库，输入框参考图不入库。
        for (let domLevel = 0; node && domLevel < 2; domLevel += 1, node = node.parentElement) {
          let propertyNames = [];
          try {
            propertyNames = Object.getOwnPropertyNames(node);
          } catch (_) {
            continue;
          }
  
          for (const name of propertyNames) {
            if (!/^__react(?:Fiber|Props|Container)\$.+/.test(name)) continue;
            let reactValue;
            try {
              reactValue = node[name];
            } catch (_) {
              continue;
            }
  
            if (!reactValue || typeof reactValue !== "object" || scannedReactValues.has(reactValue)) continue;
            scannedReactValues.add(reactValue);
            scannedTargets += 1;
  
            // 会话主区图片：替换水印的同时入库。新对话流式包常不含 chatId，仅靠 pageWindow.JSON.parse 会漏检。
            const fiberScanOpts = allowPersist
              ? { persist: true, requireChatScope: false, forcePost: false }
              : { persist: false, requireChatScope: false };
            let foundCount = 0;
            if (name.startsWith("__reactProps$")) {
              foundCount = scanObject(reactValue, 320, fiberScanOpts);
            } else {
              let fiber = reactValue;
              const visitedFibers = new WeakSet();
              for (let fiberLevel = 0; fiber && fiberLevel < 4; fiberLevel += 1) {
                if (typeof fiber !== "object" || visitedFibers.has(fiber)) break;
                visitedFibers.add(fiber);
                if (fiber.memoizedProps) {
                  foundCount += scanObject(fiber.memoizedProps, 320, fiberScanOpts);
                }
                if (fiber.pendingProps && fiber.pendingProps !== fiber.memoizedProps) {
                  foundCount += scanObject(fiber.pendingProps, 200, fiberScanOpts);
                }
                fiber = fiber.return;
              }
            }
            if (foundCount) {
              imageScanned = true;
              break;
            }
          }
          if (imageScanned) break;
        }
      }
  
      if (records.size) postImages(Array.from(records.values()));
      pageWindow.postMessage({
        type: MESSAGE_STATUS,
        status: records.size ? "captured" : "listening",
        total: records.size,
        capture_count: captureCount,
        fiber_scanned: scannedTargets
      }, pageWindow.location.origin);
    }
  
    function queueReactFiberScan(force = false) {
      pendingFiberForce = pendingFiberForce || force;
      if (fiberIdleHandle !== null) return;
      const run = () => {
        fiberIdleHandle = null;
        const shouldForce = pendingFiberForce;
        pendingFiberForce = false;
        scanReactFiber(shouldForce);
      };
      if (typeof requestIdleCallback === "function") {
        fiberIdleHandle = requestIdleCallback(run, { timeout: 650 });
      } else {
        fiberIdleHandle = setTimeout(run, 80);
      }
    }
  
    function isLikelyConversationImage(img) {
      if (!img?.isConnected) return false;
      if (img.closest('nav, aside, header, [role="navigation"], [aria-label*="导航"], [class*="sidebar" i], [class*="side-bar" i]')) {
        return false;
      }
      const linkedChat = img.closest('a[href*="/chat/"]');
      if (linkedChat) {
        try {
          const linkedId = new URL(linkedChat.href, pageWindow.location.href).pathname.match(/\/chat\/([^/?#]+)/)?.[1];
          const currentId = pageWindow.location.pathname.match(/\/chat\/([^/?#]+)/)?.[1];
          if (linkedId && currentId && linkedId !== currentId) return false;
        } catch (_) {
          return false;
        }
      }
      const main = document.querySelector('main, [role="main"]');
      if (main && !main.contains(img)) return false;
      const rect = img.getBoundingClientRect();
      if (rect.width < 110 || rect.height < 110) return false;
      const leftGuard = Math.min(180, pageWindow.innerWidth * 0.14);
      return rect.right > leftGuard;
    }
  
    function decodeEscapedUrl(value) {
      if (typeof value !== "string") return "";
      return value
        .replace(/\\u0026/gi, "&")
        .replace(/\\u003d/gi, "=")
        .replace(/\\\//g, "/")
        .replace(/&amp;/gi, "&")
        .trim();
    }
  
    function isAllowedFallbackUrl(value) {
      try {
        const url = new URL(decodeEscapedUrl(value));
        if (url.protocol !== "https:") return false;
        const host = url.hostname.toLowerCase();
        return host === "doubao.com" || host.endsWith(".doubao.com") ||
          host === "snssdk.com" || host.endsWith(".snssdk.com") ||
          host === "byteintlapi.com" || host.endsWith(".byteintlapi.com") ||
          host === "douyin.com" || host.endsWith(".douyin.com");
      } catch (_) {
        return false;
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
  
    function collectVideoFallbacks(root, rawText = "", expectedChatId = "") {
      if (!extensionEnabled || !isConcreteChatPage() || !expectedChatId) return;
      syncInjectedChat();
      const currentChatId = getPageChatId();
      if (expectedChatId !== currentChatId || expectedChatId !== boundChatId) return;
      const results = [];
      const localKeys = new Set();
      const seen = new WeakSet();
      const stack = [{ value: root, messageId: "" }];
      let inspected = 0;
  
      const add = (candidate, messageId = "") => {
        const url = decodeEscapedUrl(candidate);
        if (!isAllowedFallbackUrl(url)) return;
        const key = `${expectedChatId}::${messageId}::${url}`;
        if (videoFallbackKeys.has(key) || localKeys.has(key)) return;
        localKeys.add(key);
        results.push({ url, message_id: String(messageId || ""), page_chat_id: expectedChatId });
      };
  
      while (stack.length && inspected < 12000) {
        const frame = stack.pop();
        const current = frame.value;
        if (!current || typeof current !== "object" || seen.has(current)) continue;
        seen.add(current);
        inspected += 1;
        const messageId = directMessageId(current) || frame.messageId;
        if (!Array.isArray(current) && Object.prototype.hasOwnProperty.call(current, "fallback_api")) {
          const values = Array.isArray(current.fallback_api) ? current.fallback_api : [current.fallback_api];
          for (const candidate of values) add(candidate, messageId);
        }
        for (const child of Object.values(current)) {
          if (child && typeof child === "object") stack.push({ value: child, messageId });
        }
      }
  
      if (typeof rawText === "string" && rawText.includes("fallback_api")) {
        for (const pattern of [/fallback_api\\?"\s*:\s*\\?"(.*?)\\?"/g, /fallback_api\\\\\":\\\\\"(.*?)\\\\\"/g]) {
          let match;
          while ((match = pattern.exec(rawText))) add(match[1], "");
        }
      }
  
      if (!results.length) return;
      for (const item of results) videoFallbackKeys.add(`${expectedChatId}::${item.message_id}::${item.url}`);
      pageWindow.postMessage({ type: MESSAGE_VIDEO_FALLBACKS, items: results }, pageWindow.location.origin);
    }
  
    function inspectChainResponseText(text, expectedChatId) {
      if (typeof text !== "string" || !text.includes("fallback_api")) return;
      syncInjectedChat();
      if (!expectedChatId || expectedChatId !== getPageChatId() || expectedChatId !== boundChatId) return;
      let payload = null;
      try {
        payload = originalParse.call(pageWindow.JSON, text);
      } catch (_) {
        // 部分链路响应包含分段文本；正则提取仍可处理其中的 fallback_api。
      }
      collectVideoFallbacks(payload, text, expectedChatId);
    }
  
    pageWindow.JSON.parse = function doubaoOriginalImageParse(text, reviver) {
      const result = originalParse.call(this, text, reviver);
      try {
        if (!extensionEnabled) return result;
        syncInjectedChat();
        const chatId = boundChatId;
        // 不主动请求接口：只拦截页面自己解析的 JSON。
        // 历史会话响应通常自带 chatId；新建会话流式出图包常不含 chatId，但仍在当前具体会话页。
        if (
          isConcreteChatPage() &&
          chatId &&
          typeof text === "string" &&
          text.includes("image_ori_raw") &&
          (text.includes("creations") || text.includes('"image_ori"'))
        ) {
          captureCount += 1;
          const hasChatMarker = text.includes(chatId);
          if (hasChatMarker) {
            scanObject(result, 9000, { persist: true, requireChatScope: true });
          } else if (canPersistUnscopedPayload(text, chatId)) {
            scanCreationsOnly(result, chatId);
          }
        }
      } catch (error) {
        console.debug("[Doubao Original] 解析图片数据失败", error);
      }
      return result;
    };
  
    const originalFetch = pageWindow.fetch;
    if (typeof originalFetch === "function") {
      pageWindow.fetch = async function doubaoUserscriptFetch(...args) {
        const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
        const isChainRequest = String(requestUrl).includes("/im/chain/single");
        const requestChatId = isChainRequest ? getPageChatId() : "";
        const response = await originalFetch.apply(this, args);
        try {
          if (isChainRequest && requestChatId) {
            response.clone().text().then((text) => inspectChainResponseText(text, requestChatId)).catch(() => {});
          }
        } catch (_) {}
        return response;
      };
    }
  
    const XHR = pageWindow.XMLHttpRequest;
    if (XHR?.prototype) {
      const originalOpen = XHR.prototype.open;
      XHR.prototype.open = function doubaoUserscriptXhrOpen(method, url, ...rest) {
        this.__doubaoUserscriptUrl = String(url || "");
        if (this.__doubaoUserscriptUrl.includes("/im/chain/single")) {
          this.addEventListener("load", () => {
            try {
              if (typeof this.responseText === "string") {
                inspectChainResponseText(this.responseText, this.__doubaoUserscriptChatId);
              }
            } catch (_) {}
          }, { once: true });
        }
        return originalOpen.call(this, method, url, ...rest);
      };
      const originalSend = XHR.prototype.send;
      XHR.prototype.send = function doubaoUserscriptXhrSend(...args) {
        if (this.__doubaoUserscriptUrl?.includes("/im/chain/single")) {
          this.__doubaoUserscriptChatId = getPageChatId();
        }
        return originalSend.apply(this, args);
      };
    }
  
    pageWindow.addEventListener("message", (event) => {
      if (event.source !== pageWindow || event.origin !== pageWindow.location.origin) return;
      if (event.data?.type === "DOUBAO_USERSCRIPT_SET_ENABLED") {
        extensionEnabled = event.data.enabled !== false;
        return;
      }
      if (event.data?.type === MESSAGE_READY) {
        syncInjectedChat();
        if (extensionEnabled) postImages(Array.from(records.values()));
        pageWindow.postMessage({
          type: MESSAGE_STATUS,
          status: records.size ? "captured" : "listening",
          total: records.size,
          capture_count: captureCount
        }, pageWindow.location.origin);
      }
      if (event.data?.type === "DOUBAO_USERSCRIPT_FIBER_SCAN") {
        if (!extensionEnabled) return;
        queueReactFiberScan(Boolean(event.data.force));
      }
    });
  
    const originalPushState = pageWindow.history.pushState;
    pageWindow.history.pushState = function doubaoOriginalPushState(...args) {
      const result = originalPushState.apply(this, args);
      syncInjectedChat();
      return result;
    };
    const originalReplaceState = pageWindow.history.replaceState;
    pageWindow.history.replaceState = function doubaoOriginalReplaceState(...args) {
      const result = originalReplaceState.apply(this, args);
      syncInjectedChat();
      return result;
    };
    pageWindow.addEventListener("popstate", () => syncInjectedChat());
  
    pageWindow.postMessage({
      type: MESSAGE_STATUS,
      status: "listening",
      total: 0,
      capture_count: 0
    }, pageWindow.location.origin);
  })();
  
  (() => {
    "use strict";
  
    const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    if (window.__DOUBAO_IMAGE_USERSCRIPT_UI__) return;
    window.__DOUBAO_IMAGE_USERSCRIPT_UI__ = true;
  
    const MESSAGE_IMAGES = "DOUBAO_USERSCRIPT_IMAGES";
    const MESSAGE_READY = "DOUBAO_USERSCRIPT_BRIDGE_READY";
    const MESSAGE_SCAN = "DOUBAO_USERSCRIPT_FIBER_SCAN";
    const MESSAGE_CHAT_CHANGED = "DOUBAO_USERSCRIPT_CHAT_CHANGED";
    const MESSAGE_VIDEO_FALLBACKS = "DOUBAO_USERSCRIPT_VIDEO_FALLBACKS";
    const records = new Map();
    const videos = new Map();
    const resolvingVideoUrls = new Set();
    let boundChatId = getChatId();
    let scanTimer = null;
    let scanWindowUntil = Date.now() + 2400;
    let panelApi = null;
  
    function getChatId() {
      try {
        const url = new URL(pageWindow.location.href);
        const pathId = url.pathname.match(/\/(?:chat|conversation)\/([^/?#]+)/i)?.[1];
        return String(
          url.searchParams.get("conversation_id") ||
          url.searchParams.get("conversationId") ||
          url.searchParams.get("chat_id") ||
          url.searchParams.get("chatId") ||
          pathId || ""
        ).trim();
      } catch (_) {
        return "";
      }
    }
  
    function isConcreteChatId(value) {
      return value.length >= 10 && /^[a-zA-Z0-9_-]+$/.test(value) &&
        !/^(home|chat|conversation|new|index)$/i.test(value);
    }
  
    function safeUrl(value) {
      if (typeof value !== "string" || value.length > 8192) return "";
      try {
        const url = new URL(value, pageWindow.location.href);
        return url.protocol === "https:" ? url.href : "";
      } catch (_) {
        return "";
      }
    }
  
    function absoluteHttpsUrl(value) {
      if (typeof value !== "string" || !/^https:\/\//i.test(value.trim())) return "";
      try {
        const url = new URL(value.trim());
        return url.protocol === "https:" ? url.href : "";
      } catch (_) {
        return "";
      }
    }
  
    function normalizeRecord(record) {
      if (!record || typeof record !== "object") return null;
      const rawUrl = safeUrl(record.image_ori_raw_url || record.best_url);
      if (!rawUrl) return null;
      const imageId = String(record.image_id || rawUrl.split(/[?#]/)[0]).slice(0, 500);
      if (!imageId) return null;
      return {
        ...record,
        image_id: imageId,
        image_ori_raw_url: rawUrl,
        best_url: rawUrl,
        width: Number(record.width) > 0 ? Number(record.width) : 0,
        height: Number(record.height) > 0 ? Number(record.height) : 0,
        page_chat_id: String(record.page_chat_id || boundChatId),
        captured_at: Number(record.captured_at) || Date.now()
      };
    }
  
    function resetForChat(nextChatId = getChatId()) {
      boundChatId = nextChatId;
      records.clear();
      videos.clear();
      resolvingVideoUrls.clear();
      scanWindowUntil = Date.now() + 2400;
      panelApi?.render();
      requestScan(true, 0);
      requestScan(true, 180);
      requestScan(true, 650);
      requestScan(true, 1500);
    }
  
    function syncChat() {
      const current = getChatId();
      if (current !== boundChatId) resetForChat(current);
      return current;
    }
  
    function requestScan(force = false, delay = 80) {
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = setTimeout(() => {
        scanTimer = null;
        pageWindow.postMessage({ type: MESSAGE_SCAN, force }, pageWindow.location.origin);
      }, Math.max(0, delay));
    }
  
    function sanitizeFilename(value) {
      return String(value || "豆包会话")
        .replace(/\s*[-|_]\s*豆包\s*$/i, "")
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 70) || "豆包会话";
    }
  
    function extensionFor(record) {
      const explicit = String(record.extension || "").toLowerCase();
      if (["jpg", "jpeg", "png", "webp", "avif", "gif"].includes(explicit)) {
        return explicit === "jpeg" ? "jpg" : explicit;
      }
      try {
        const match = decodeURIComponent(new URL(record.image_ori_raw_url).pathname)
          .match(/\.([a-z0-9]{2,5})$/i);
        const ext = String(match?.[1] || "").toLowerCase();
        return ["jpg", "jpeg", "png", "webp", "avif", "gif"].includes(ext)
          ? (ext === "jpeg" ? "jpg" : ext)
          : "jpg";
      } catch (_) {
        return "jpg";
      }
    }
  
    function filenameFor(record, index) {
      const title = sanitizeFilename(document.title);
      const chatId = isConcreteChatId(boundChatId) ? boundChatId : "new-chat";
      const order = String(index + 1).padStart(2, "0");
      return `${title}-${chatId}-${order}.${extensionFor(record)}`;
    }
  
    function downloadRecord(record, index) {
      return new Promise((resolve, reject) => {
        const details = {
          url: record.image_ori_raw_url,
          name: filenameFor(record, index),
          saveAs: false,
          onload: () => resolve(true),
          onerror: (error) => reject(new Error(error?.error || "下载失败")),
          ontimeout: () => reject(new Error("下载超时"))
        };
        try {
          const task = GM_download(details);
          if (task && typeof task.catch === "function") task.catch(reject);
        } catch (error) {
          reject(error);
        }
      });
    }

    function gmFetchBytes(url, timeout = 90000) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          responseType: "arraybuffer",
          anonymous: true,
          timeout,
          onload: (response) => {
            if (response.status < 200 || response.status >= 300) {
              reject(new Error(`资源 HTTP ${response.status}`));
              return;
            }
            resolve(new Uint8Array(response.response || new ArrayBuffer(0)));
          },
          onerror: () => reject(new Error("资源下载失败")),
          ontimeout: () => reject(new Error("资源下载超时"))
        });
      });
    }

    function concatMany(parts) {
      const total = parts.reduce((sum, part) => sum + part.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
      }
      return out;
    }

    const CRC_TABLE = (() => {
      const table = new Uint32Array(256);
      for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) {
          value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
        }
        table[index] = value >>> 0;
      }
      return table;
    })();

    function crc32(data) {
      let crc = 0xFFFFFFFF;
      for (let index = 0; index < data.length; index += 1) {
        crc = CRC_TABLE[(crc ^ data[index]) & 0xFF] ^ (crc >>> 8);
      }
      return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    function u16le(value) {
      const bytes = new Uint8Array(2);
      new DataView(bytes.buffer).setUint16(0, value, true);
      return bytes;
    }

    function u32le(value) {
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setUint32(0, value, true);
      return bytes;
    }

    function buildZipStore(entries) {
      const locals = [];
      const centrals = [];
      let offset = 0;
      for (const entry of entries) {
        const nameBytes = new TextEncoder().encode(entry.name);
        const data = entry.data;
        const checksum = crc32(data);
        const local = concatMany([
          u32le(0x04034b50),
          u16le(20),
          u16le(0x0800),
          u16le(0),
          u16le(0),
          u16le(0),
          u32le(checksum),
          u32le(data.length),
          u32le(data.length),
          u16le(nameBytes.length),
          u16le(0),
          nameBytes,
          data
        ]);
        const central = concatMany([
          u32le(0x02014b50),
          u16le(20),
          u16le(20),
          u16le(0x0800),
          u16le(0),
          u16le(0),
          u16le(0),
          u32le(checksum),
          u32le(data.length),
          u32le(data.length),
          u16le(nameBytes.length),
          u16le(0),
          u16le(0),
          u16le(0),
          u16le(0),
          u32le(0),
          u32le(offset),
          nameBytes
        ]);
        locals.push(local);
        centrals.push(central);
        offset += local.length;
      }
      const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
      const end = concatMany([
        u32le(0x06054b50),
        u16le(0),
        u16le(0),
        u16le(entries.length),
        u16le(entries.length),
        u32le(centralSize),
        u32le(offset),
        u16le(0)
      ]);
      return concatMany([...locals, ...centrals, end]);
    }

    function saveBlobAs(blob, filename) {
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      link.rel = "noopener";
      link.style.display = "none";
      (document.body || document.documentElement).appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
    }

    async function downloadItemsAsZip(type, items, onProgress) {
      const files = [];
      for (let index = 0; index < items.length; index += 1) {
        onProgress?.(index + 1, items.length);
        const record = items[index];
        if (type === "video") {
          const current = await refreshedVideo(record);
          const bytes = await gmFetchBytes(current.url, 180000);
          files.push({ name: videoFilename(current, index), data: bytes });
        } else {
          const bytes = await gmFetchBytes(record.image_ori_raw_url, 90000);
          files.push({ name: filenameFor(record, index), data: bytes });
        }
      }
      if (!files.length) throw new Error("没有可打包的文件");
      const zipBytes = buildZipStore(files);
      const title = sanitizeFilename(document.title);
      const chatId = isConcreteChatId(boundChatId) ? boundChatId : "new-chat";
      const kind = type === "video" ? "视频" : "图片";
      const zipName = `${title}-${chatId}-${kind}.zip`;
      saveBlobAs(new Blob([zipBytes], { type: "application/zip" }), zipName);
      return files.length;
    }

    function gmRequestText(url) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          anonymous: true,
          timeout: 30000,
          headers: { Accept: "application/json,text/plain,*/*" },
          onload: (response) => {
            if (response.status < 200 || response.status >= 300) {
              reject(new Error(`视频接口 HTTP ${response.status}`));
              return;
            }
            resolve(response.responseText || "");
          },
          onerror: () => reject(new Error("视频接口请求失败")),
          ontimeout: () => reject(new Error("视频接口请求超时"))
        });
      });
    }
  
    function fallbackRequestUrl(value) {
      const url = new URL(value);
      url.searchParams.set("channel", "no");
      url.searchParams.set("codec_type", "8");
      url.searchParams.set("logo_type", "unwatermarked");
      return url.href;
    }
  
    function base64DecodeLoose(value) {
      if (typeof value !== "string" || !value.trim()) return null;
      const input = value.trim();
      const variants = [
        input,
        input.replace(/[$@#]/g, (char) => ({ "$": "_", "@": "/", "#": "." })[char]),
        input.replace(/[$@#]/g, (char) => ({ "$": "+", "@": "/", "#": "=" })[char])
      ];
      for (const candidate of new Set(variants)) {
        try {
          let normalized = candidate.replace(/-/g, "+").replace(/_/g, "/");
          normalized += "=".repeat((4 - normalized.length % 4) % 4);
          const binary = atob(normalized);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
          return bytes;
        } catch (_) {}
      }
      return null;
    }
  
    function concatBytes(left, right) {
      const result = new Uint8Array(left.length + right.length);
      result.set(left, 0);
      result.set(right, left.length);
      return result;
    }

    function decodedUrl(bytes) {
      if (!(bytes instanceof Uint8Array) || !bytes.length) return "";
      try {
        const text = new TextDecoder().decode(bytes).replace(/\0+$/g, "").trim();
        const start = text.indexOf("https://");
        if (start < 0) return "";
        const url = text.slice(start).replace(/[\x00-\x20]+$/g, "");
        return safeUrl(url);
      } catch (_) {
        return "";
      }
    }

    // 媒体参数材料（分段还原，避免明文常量）
    function _matBytes() {
      const m = 0x5a;
      const packed = [
        0x17,0x8e,0x98,0xbc,0xe2,0x6b,0x38,0x53,0x54,0x08,0xe9,0x9d,0xfc,0x29,0x61,0xfe,
        0x46,0xe8,0x1c,0x71,0xd8,0xc0,0xef,0xd0,0x43,0x31,0x63,0x81,0x0d,0x4d,0x2f,0x7e,
        0xae,0xc1,0xf5,0x25,0x52,0xb2,0x8c,0xd7,0x7c,0xfd,0x74,0x6d,0x9b,0xf3,0x00,0x75,
        0x45,0x5f,0xff,0x42,0xc8,0xf4,0xa8,0xce,0xcd,0x68,0xec,0x70,0x62,0xf0,0x87,0x02
      ];
      return Uint8Array.from(packed, (n) => n ^ m);
    }

    function _tagHead() {
      return String.fromCharCode(113, 65, 65, 66);
    }

    function _cipherName() {
      return ["A", "ES", "-", "C", "BC"].join("");
    }

    function _hashName() {
      return ["SHA", "-", "512"].join("");
    }

    async function _openBlob(payload, a, b) {
      if (!payload.length || payload.length % 16 !== 0) return "";
      try {
        const material = await crypto.subtle.importKey("raw", a, _cipherName(), false, ["decrypt"]);
        const plain = new Uint8Array(await crypto.subtle.decrypt(
          { name: _cipherName(), iv: b },
          material,
          payload
        ));
        return decodedUrl(plain);
      } catch (_) {
        return "";
      }
    }

    async function _resolveHref(token, seedRaw) {
      const direct = absoluteHttpsUrl(token);
      if (direct) return direct;
      const data = base64DecodeLoose(token);
      if (!data) return "";
      const plain = decodedUrl(data);
      if (plain) return plain;
      if (!token.startsWith(_tagHead()) || !seedRaw) return "";
      const seed = base64DecodeLoose(seedRaw);
      if (!seed) return "";
      const round1 = new Uint8Array(await crypto.subtle.digest(_hashName(), seed.slice(0, 32)));
      const round2 = new Uint8Array(await crypto.subtle.digest(
        _hashName(),
        concatBytes(round1, _matBytes())
      ));
      const partA = round2.slice(0, 16);
      const partB = round2.slice(16, 32);
      const tries = [];
      if (data.length >= 4 && data[0] === 0xa8 && data[1] === 0 && data[2] === 1 && data[3] === 0) {
        tries.push({ payload: data.slice(4), a: partA, b: partB });
        tries.push({ payload: data.slice(4), a: partB, b: partA });
        if (data.length > 36) {
          tries.push({ payload: data.slice(36), a: partA, b: data.slice(20, 36) });
          tries.push({ payload: data.slice(36), a: partA, b: partB });
        }
      } else {
        tries.push({ payload: data, a: partA, b: partB });
      }
      for (const item of tries) {
        const href = await _openBlob(item.payload, item.a, item.b);
        if (href) return href;
      }
      return "";
    }

    function _pickSeed(root) {
      const seen = new WeakSet();
      const stack = [root];
      let inspected = 0;
      const field = ["key", "_", "seed"].join("");
      while (stack.length && inspected < 5000) {
        const value = stack.pop();
        if (!value || typeof value !== "object" || seen.has(value)) continue;
        seen.add(value);
        inspected += 1;
        if (typeof value[field] === "string" && value[field].trim()) return value[field].trim();
        for (const child of Object.values(value)) {
          if (child && typeof child === "object") stack.push(child);
        }
      }
      return "";
    }

    function findPosterUrl(root) {
      const seen = new WeakSet();
      const stack = [root];
      let inspected = 0;
      while (stack.length && inspected < 5000) {
        const value = stack.pop();
        if (!value || typeof value !== "object" || seen.has(value)) continue;
        seen.add(value);
        inspected += 1;
        for (const key of ["poster_url", "cover_url", "posterUrl", "coverUrl"]) {
          const url = safeUrl(value[key]);
          if (url) return url;
        }
        for (const child of Object.values(value)) {
          if (child && typeof child === "object") stack.push(child);
        }
      }
      return "";
    }
  
    function getVideoData(payload) {
      const info = payload?.video_info || payload?.data?.video_info || payload;
      return info?.data || info || {};
    }
  
    function pickHighestVideo(data) {
      const list = data?.video_list;
      const candidates = list && typeof list === "object" ? Object.values(list) : [data];
      let best = null;
      for (const value of candidates) {
        if (!value || typeof value !== "object") continue;
        const token = String(value.main_url || value.play_url || "").trim();
        if (!token) continue;
        const item = {
          token,
          width: Number(value.vwidth || value.width || 0),
          height: Number(value.vheight || value.height || 0),
          bitrate: Number(value.real_bitrate || value.bitrate || 0),
          size: Number(value.size || 0),
          format: String(value.vtype || value.format || "mp4").toLowerCase(),
          definition: String(value.definition || value.quality || ""),
          video_id: String(value.file_id || data.video_id || "")
        };
        const pixels = item.width * item.height;
        const bestPixels = best ? best.width * best.height : -1;
        if (!best || pixels > bestPixels || (pixels === bestPixels && item.bitrate > best.bitrate)) best = item;
      }
      return best;
    }
  
    async function resolveFallbackMedia(item) {
      const chatId = String(item.page_chat_id || boundChatId);
      const text = await gmRequestText(fallbackRequestUrl(item.url));
      const payload = JSON.parse(text);
      const data = getVideoData(payload);
      const selected = pickHighestVideo(data);
      if (!selected) throw new Error("接口没有返回视频清晰度列表");
      const url = await _resolveHref(selected.token, _pickSeed(payload));
      if (!url) throw new Error("未能解析无水印视频地址");
      const videoId = selected.video_id || String(data.video_id || "") || item.url;
      return {
        video_record_id: `${chatId}::${videoId}`,
        video_id: videoId,
        message_id: String(item.message_id || ""),
        fallback_api: item.url,
        url,
        poster_url: findPosterUrl(payload),
        width: selected.width,
        height: selected.height,
        bitrate: selected.bitrate,
        size: selected.size,
        format: selected.format || "mp4",
        definition: selected.definition,
        page_chat_id: chatId,
        captured_at: Date.now()
      };
    }
  
    async function queueVideoFallback(item) {
      if (!item?.url || item.page_chat_id !== boundChatId || resolvingVideoUrls.has(item.url)) return;
      if (Array.from(videos.values()).some((video) => video.fallback_api === item.url)) return;
      resolvingVideoUrls.add(item.url);
      const expectedChatId = boundChatId;
      panelApi?.render();
      try {
        let video = null;
        let lastError = null;
        for (let attempt = 0; attempt < 2 && !video; attempt += 1) {
          try {
            video = await resolveFallbackMedia(item);
          } catch (error) {
            lastError = error;
            if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
        if (!video) throw lastError || new Error("视频解析失败");
        if (boundChatId !== expectedChatId || video.page_chat_id !== expectedChatId) return;
        videos.set(video.video_record_id, video);
      } catch (error) {
        console.warn("[豆包图片视频去水印] 视频解析失败", error.message);
      } finally {
        resolvingVideoUrls.delete(item.url);
        panelApi?.render();
      }
    }
  
    function videoExtension(record) {
      const format = String(record.format || "mp4").toLowerCase();
      return ["mp4", "webm", "mov", "mkv"].includes(format) ? format : "mp4";
    }
  
    function videoFilename(record, index) {
      const title = sanitizeFilename(document.title);
      const chatId = isConcreteChatId(boundChatId) ? boundChatId : "new-chat";
      return `${title}-${chatId}-视频${String(index + 1).padStart(2, "0")}.${videoExtension(record)}`;
    }
  
    async function refreshedVideo(record) {
      try {
        const next = await resolveFallbackMedia({
          url: record.fallback_api,
          message_id: record.message_id,
          page_chat_id: boundChatId
        });
        const merged = { ...record, ...next, video_record_id: record.video_record_id };
        videos.set(merged.video_record_id, merged);
        return merged;
      } catch (error) {
        if (safeUrl(record.url)) return record;
        throw error;
      }
    }
  
    async function downloadVideoRecord(record, index) {
      const current = await refreshedVideo(record);
      return new Promise((resolve, reject) => {
        try {
          const task = GM_download({
            url: current.url,
            name: videoFilename(current, index),
            saveAs: false,
            onload: () => resolve(true),
            onerror: (error) => reject(new Error(error?.error || "视频下载失败")),
            ontimeout: () => reject(new Error("视频下载超时"))
          });
          if (task && typeof task.catch === "function") task.catch(reject);
        } catch (error) {
          reject(error);
        }
      });
    }
  
    function createPanel() {
      const host = document.createElement("div");
      host.id = "doubao-image-userscript-panel";
      const OPEN_POS = "position:fixed;right:16px;bottom:100px;left:auto;top:auto;transform:none;z-index:2147483645;pointer-events:auto";
      // 关闭态：完整圆形贴在右边缘内侧（不裁切成半圆）
      const EDGE_POS = "position:fixed;right:8px;bottom:100px;left:auto;top:auto;transform:none;z-index:2147483645;pointer-events:auto";
      host.style.cssText = OPEN_POS;
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <style>
          *{box-sizing:border-box;font-family:Arial,"Microsoft YaHei",sans-serif}
          button{font:inherit;cursor:pointer}
          #panel{display:flex;flex-direction:column;width:326px;height:320px;max-height:calc(100vh - 120px);overflow:hidden;border:1px solid rgba(0,87,255,.18);border-radius:14px;background:#fff;color:#27272a;box-shadow:0 16px 40px rgba(20,45,90,.18)}
          #panel.collapsed{height:auto}
          header{display:grid;grid-template-columns:28px minmax(0,1fr) 28px;align-items:center;gap:9px;flex:0 0 auto;padding:10px 11px;background:linear-gradient(110deg,#0057ff,#2387ff);color:#fff;cursor:move;user-select:none;touch-action:none}
          .title{min-width:0;text-align:center}.title strong{display:flex;align-items:center;justify-content:center;gap:6px;font-size:13px}
          .dot{width:7px;height:7px;border-radius:50%;background:#35dc72;box-shadow:0 0 0 2px rgba(255,255,255,.18)}
          .icon{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:rgba(255,255,255,.18);color:#fff}.icon:hover{background:rgba(255,255,255,.28)}
          #collapse svg{width:14px;height:14px;transition:transform .2s}.collapsed #collapse svg{transform:rotate(180deg)}
          #tabs{display:flex;flex:0 0 auto;padding:7px 10px 0;background:#fff;border-bottom:1px solid #e4e4e7}.tab{flex:1;height:32px;border:0;border-bottom:2px solid transparent;background:#fff;color:#71717a;font-size:11px}.tab.active{border-bottom-color:#0057ff;color:#0057ff;font-weight:700}
          #body{min-height:0;flex:1 1 auto;overflow:auto;padding:7px 8px;background:#f7f8fa}.collapsed #tabs,.collapsed #body,.collapsed footer{display:none}
          .empty{padding:30px 10px;text-align:center;color:#71717a;font-size:11px;line-height:1.7}
          .item{display:flex;align-items:center;gap:8px;margin-bottom:4px;padding:6px;border:1px solid #e4e4e7;border-radius:10px;background:#fff}.item:last-child{margin-bottom:0}
          .thumb{width:54px;height:54px;flex:0 0 54px;border-radius:8px;object-fit:cover;background:#e4e4e7}.info{min-width:0;flex:1}.info strong{display:block;font-size:11px}.info span{display:block;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#a1a1aa;font-size:9px}
          .download{height:29px;padding:0 10px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:10px}.download:disabled{opacity:.55;cursor:wait}
          footer{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:0 0 auto;padding:9px 11px;border-top:1px solid #e4e4e7;background:#fff}
          footer button#all{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:31px;padding:0 12px;border:0;border-radius:9px;background:#2563eb;color:#fff;font-size:11px;font-weight:600}
          footer button#all svg{width:14px;height:14px;flex:0 0 auto;stroke:currentColor;fill:none}
          #all:disabled{opacity:.45;cursor:not-allowed}
          .support-wrap{position:relative}.support{display:inline-flex;align-items:center;gap:4px;height:30px;padding:0 10px;border:0;border-radius:9px;background:#f4f4f5;text-decoration:none;font-size:11px;font-weight:600}.support:hover{background:#e4e4e7}.support .support-text{background-image:linear-gradient(110deg,#06b6d4,#2563eb);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent}.heart{color:#f43f5e;font-size:15px;font-weight:400;-webkit-text-fill-color:#f43f5e}
          .support-tip{position:absolute;left:0;bottom:38px;width:max-content;max-width:min(320px,calc(100vw - 48px));padding:11px 12px;border:1px solid #e4e4e7;border-radius:11px;background:#fff;color:#3f3f46;box-shadow:0 10px 28px rgba(15,23,42,.18);font-size:11px;line-height:1.55;white-space:nowrap;opacity:0;visibility:hidden;transform:translateY(5px);transition:opacity .16s ease,transform .16s ease,visibility .16s;pointer-events:none}.support-tip strong{display:block;margin-bottom:3px;color:#18181b;font-size:12px;text-align:left}.support-tip .tip-line{display:block;color:#18181b;font-weight:700}.support-tip .tip-line .tip-label{font-weight:700;color:#18181b}.support-tip .tip-line .tip-muted{font-weight:400;color:#3f3f46}.support-wrap:hover .support-tip,.support-wrap:focus-within .support-tip{opacity:1;visibility:visible;transform:translateY(0)}
          #launcher{display:none;width:46px;height:46px;border:0;border-radius:50%;background:#0057ff;color:#fff;font-size:20px;box-shadow:0 8px 24px rgba(0,87,255,.3)}#panel.closed{display:none}#panel.closed+#launcher{display:block}
        </style>
        <section id="panel">
          <header>
            <button id="collapse" class="icon" title="收起面板"><svg viewBox="0 0 24 24"><path d="m6 15 6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            <div class="title"><strong>豆包图片视频去水印 <i class="dot"></i></strong></div>
            <button id="close" class="icon" title="关闭">×</button>
          </header>
          <nav id="tabs"><button class="tab active" data-type="image">图片 <b id="image-count">0</b></button><button class="tab" data-type="video">视频 <b id="video-count">0</b></button></nav>
          <div id="body"><div id="list"><div class="empty">当前会话暂未识别到图片</div></div></div>
          <footer>
            <div class="support-wrap">
              <a class="support" href="https://github.com/XiaoYu43002/DoubaoWaterMark-Remover" target="_blank" rel="noopener noreferrer"><span class="heart">♡</span><span class="support-text">支持作者</span></a>
              <div class="support-tip"><strong>嗨，我是开发者十一木 👋</strong><span class="tip-line"><span class="tip-label">打赏或更多项目细节</span><span class="tip-muted">：点下方支持作者进入</span></span><span class="tip-line"><span class="tip-label">开发交流</span><span class="tip-muted">：1121421959</span></span></div>
            </div>
            <button id="all" type="button" disabled>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10m0 0 4-4m-4 4-4-4M5 18h14" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <span>全部下载</span>
            </button>
          </footer>
        </section>
        <button id="launcher" title="打开豆包图片视频去水印">◈</button>`;
  
      const panel = shadow.getElementById("panel");
      const header = shadow.querySelector("header");
      const list = shadow.getElementById("list");
      const all = shadow.getElementById("all");
      const allLabel = all.querySelector("span");
      let activeType = "image";

      function setAllLabel(text) {
        if (allLabel) allLabel.textContent = text;
        else all.textContent = text;
      }

      function dockOpen() {
        host.style.cssText = OPEN_POS;
      }

      function dockEdge() {
        host.style.cssText = EDGE_POS;
      }

      let dragging = false;
      let startX = 0;
      let startY = 0;
      let startLeft = 0;
      let startTop = 0;
      header.addEventListener("pointerdown", (event) => {
        if (event.target.closest("button")) return;
        const rect = host.getBoundingClientRect();
        dragging = true;
        startX = event.clientX;
        startY = event.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        host.style.left = `${rect.left}px`;
        host.style.top = `${rect.top}px`;
        host.style.right = "auto";
        host.style.bottom = "auto";
        host.style.transform = "none";
        header.setPointerCapture(event.pointerId);
      });
      header.addEventListener("pointermove", (event) => {
        if (!dragging) return;
        const maxLeft = Math.max(0, pageWindow.innerWidth - host.offsetWidth);
        const maxTop = Math.max(0, pageWindow.innerHeight - host.offsetHeight);
        host.style.left = `${Math.min(maxLeft, Math.max(0, startLeft + event.clientX - startX))}px`;
        host.style.top = `${Math.min(maxTop, Math.max(0, startTop + event.clientY - startY))}px`;
      });
      const stopDrag = () => { dragging = false; };
      header.addEventListener("pointerup", stopDrag);
      header.addEventListener("pointercancel", stopDrag);

      shadow.getElementById("collapse").addEventListener("click", () => panel.classList.toggle("collapsed"));
      shadow.getElementById("close").addEventListener("click", () => {
        panel.classList.add("closed");
        dockEdge();
      });
      shadow.getElementById("launcher").addEventListener("click", () => {
        panel.classList.remove("closed");
        dockOpen();
      });
      shadow.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => {
        activeType = button.dataset.type;
        render();
      }));
  
      async function downloadOne(type, record, index, button) {
        button.disabled = true;
        const previous = button.textContent;
        button.textContent = "下载中";
        try {
          if (type === "video") await downloadVideoRecord(record, index);
          else await downloadRecord(record, index);
          button.textContent = "已下载";
        } catch (error) {
          console.error("[豆包图片视频去水印]", error);
          button.textContent = "重试";
        } finally {
          setTimeout(() => {
            button.disabled = false;
            if (button.textContent === "已下载") button.textContent = previous;
          }, 1000);
        }
      }
  
      function render() {
        const images = Array.from(records.values()).sort((a, b) => a.captured_at - b.captured_at);
        const videoItems = Array.from(videos.values()).sort((a, b) => a.captured_at - b.captured_at);
        const items = activeType === "video" ? videoItems : images;
        list.replaceChildren();
        shadow.getElementById("image-count").textContent = String(images.length);
        shadow.getElementById("video-count").textContent = String(videoItems.length);
        shadow.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.type === activeType));
        const resolving = resolvingVideoUrls.size;
        setAllLabel("全部下载");
        all.disabled = items.length === 0;
        if (!items.length) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = activeType === "video"
            ? (resolving ? "正在提取无水印视频，请稍候…" : "当前会话暂未识别到视频")
            : "当前会话暂未识别到图片";
          list.appendChild(empty);
          return;
        }
        items.forEach((record, index) => {
          const item = document.createElement("div");
          item.className = "item";
          const image = document.createElement("img");
          image.className = "thumb";
          image.loading = "lazy";
          image.decoding = "async";
          image.alt = activeType === "video" ? "无水印视频封面" : "无水印图片缩略图";
          const info = document.createElement("div");
          info.className = "info";
          const name = document.createElement("strong");
          name.textContent = activeType === "video" ? `无水印视频 ${index + 1}` : `无水印图片 ${index + 1}`;
          const meta = document.createElement("span");
          const formatMeta = () => {
            const size = record.width && record.height ? `${record.width} × ${record.height}` : "原始尺寸";
            const format = activeType === "video" ? videoExtension(record) : extensionFor(record);
            meta.textContent = `${size} · ${format.toUpperCase()}${activeType === "video" && record.definition ? ` · ${record.definition}` : ""}`;
          };
          formatMeta();
          // 图片接口常缺宽高：用原图像素补全；视频逻辑不改。
          if (activeType !== "video" && (!record.width || !record.height)) {
            const applySize = (width, height) => {
              if (!(width > 0 && height > 0) || (record.width && record.height)) return;
              record.width = width;
              record.height = height;
              records.set(record.image_id, record);
              formatMeta();
            };
            const measureUrl = record.image_ori_raw_url || record.image_ori_url ||
              record.image_preview_url || record.image_thumb_url;
            if (measureUrl) {
              const probe = new Image();
              probe.decoding = "async";
              probe.onload = () => applySize(probe.naturalWidth, probe.naturalHeight);
              probe.src = measureUrl;
            }
            image.addEventListener("load", () => {
              applySize(image.naturalWidth, image.naturalHeight);
            }, { once: true });
          }
          image.src = activeType === "video"
            ? record.poster_url || ""
            : record.image_thumb_url || record.image_preview_url || record.image_ori_url || record.image_ori_raw_url;
          info.append(name, meta);
          const button = document.createElement("button");
          button.className = "download";
          button.textContent = "下载";
          const type = activeType;
          button.addEventListener("click", () => downloadOne(type, record, index, button));
          item.append(image, info, button);
          list.appendChild(item);
        });
      }
  
      all.addEventListener("click", async () => {
        const images = Array.from(records.values()).sort((a, b) => a.captured_at - b.captured_at);
        const videoItems = Array.from(videos.values()).sort((a, b) => a.captured_at - b.captured_at);
        const type = activeType;
        const items = type === "video" ? videoItems : images;
        if (!items.length) return;
        all.disabled = true;
        try {
          const count = await downloadItemsAsZip(type, items, (current, total) => {
            setAllLabel(`打包 ${current}/${total}`);
          });
          setAllLabel(`已打包 ${count}`);
        } catch (error) {
          console.error("[豆包图片视频去水印] 打包下载失败", error);
          setAllLabel("打包失败");
        }
        setTimeout(() => {
          setAllLabel("全部下载");
          all.disabled = false;
        }, 1600);
      });
  
      const append = () => {
        if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host);
      };
      append();
      if (!host.isConnected) document.addEventListener("DOMContentLoaded", append, { once: true });
  
      return {
        render,
        show: () => {
          panel.classList.remove("closed");
          dockOpen();
        },
        clear: () => {
          records.clear();
          videos.clear();
          render();
        }
      };
    }
  
    function acceptImages(images) {
      syncChat();
      if (!isConcreteChatId(boundChatId)) return;
      let changed = false;
      for (const value of images) {
        const record = normalizeRecord(value);
        if (!record || (record.page_chat_id && record.page_chat_id !== boundChatId)) continue;
        const previous = records.get(record.image_id);
        const merged = previous
          ? {
              ...previous,
              ...record,
              width: Number(record.width) || previous.width || 0,
              height: Number(record.height) || previous.height || 0,
              extension: record.extension || previous.extension || null,
              captured_at: Math.min(previous.captured_at || Date.now(), record.captured_at || Date.now())
            }
          : record;
        const isNew = !previous;
        const urlChanged = previous && previous.image_ori_raw_url !== merged.image_ori_raw_url;
        const sizeChanged = previous && (
          (merged.width || 0) !== (previous.width || 0) ||
          (merged.height || 0) !== (previous.height || 0)
        );
        if (isNew || urlChanged || sizeChanged) {
          records.set(merged.image_id, merged);
          changed = true;
        }
      }
      if (changed) panelApi?.render();
    }
  
    pageWindow.addEventListener("message", (event) => {
      if (event.source !== pageWindow || event.origin !== pageWindow.location.origin) return;
      if (event.data?.type === MESSAGE_CHAT_CHANGED) {
        resetForChat(String(event.data.chat_id || getChatId()));
        return;
      }
      if (event.data?.type === MESSAGE_IMAGES && Array.isArray(event.data.images)) {
        acceptImages(event.data.images);
        return;
      }
      if (event.data?.type === MESSAGE_VIDEO_FALLBACKS && Array.isArray(event.data.items)) {
        syncChat();
        for (const item of event.data.items) queueVideoFallback(item);
      }
    });
  
    const mutationObserver = new MutationObserver((mutations) => {
      syncChat();
      let containsImage = false;
      for (const mutation of mutations) {
        if (mutation.type === "attributes" && mutation.target?.tagName === "IMG") {
          containsImage = true;
          break;
        }
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.tagName === "IMG" || node.querySelector?.("img")) {
            containsImage = true;
            break;
          }
        }
        if (containsImage) break;
      }
      if (containsImage) requestScan(Date.now() < scanWindowUntil, Date.now() < scanWindowUntil ? 90 : 260);
    });
  
    function start() {
      panelApi = createPanel();
      panelApi.render();
      mutationObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "srcset"]
      });
      pageWindow.postMessage({ type: MESSAGE_READY }, pageWindow.location.origin);
      requestScan(true, 60);
      requestScan(true, 500);
      requestScan(true, 1400);
    }
  
    if (document.documentElement) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });

    if (typeof GM_registerMenuCommand === "function") {
      GM_registerMenuCommand("显示图片视频下载面板", () => panelApi?.show());
      GM_registerMenuCommand("重新识别当前会话媒体", () => {
        records.clear();
        videos.clear();
        panelApi?.render();
        scanWindowUntil = Date.now() + 2400;
        requestScan(true, 0);
      });
      GM_registerMenuCommand("清空当前会话媒体记录", () => panelApi?.clear());
    }
  })();
  