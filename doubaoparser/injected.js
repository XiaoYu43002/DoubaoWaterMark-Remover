(() => {
  "use strict";

  if (window.__DOUBAO_ORIGINAL_IMAGE_HOOK__) return;
  window.__DOUBAO_ORIGINAL_IMAGE_HOOK__ = true;

  const MESSAGE_IMAGES = "DOUBAO_ORIGINAL_IMAGES";
  const MESSAGE_STATUS = "DOUBAO_ORIGINAL_STATUS";
  const MESSAGE_READY = "DOUBAO_ORIGINAL_BRIDGE_READY";
  const records = new Map();
  const rawUrlIndex = new Map();
  const originalParse = JSON.parse;
  let captureCount = 0;
  let lastFiberScanAt = 0;
  let fiberIdleHandle = null;
  let pendingFiberForce = false;
  let extensionEnabled = true;

  function safeUrl(value) {
    if (typeof value !== "string" || value.length > 8192) return null;
    try {
      const url = new URL(value, location.href);
      return url.protocol === "https:" ? url.href : null;
    } catch (_) {
      return null;
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

  function canonicalRawUrl(record) {
    return record?.image_ori_raw_url || record?.best_url || "";
  }

  function rememberRawUrl(record) {
    const rawUrl = canonicalRawUrl(record);
    if (rawUrl) rawUrlIndex.set(rawUrl, record.image_id);
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

    const width = Number(obj.width || obj.image_width || obj.ori_width || 0);
    const height = Number(obj.height || obj.image_height || obj.ori_height || 0);
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
    const rawUrl = canonicalRawUrl(next);
    const existingId = rawUrl ? imageIdForRawUrl(rawUrl) : null;
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
      const url = new URL(location.href);
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
      const url = new URL(location.href);
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
      boundChatId = chatId;
      captureCount = 0;
      window.postMessage({ type: "DOUBAO_CHAT_CHANGED", chat_id: chatId }, location.origin);
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
    window.postMessage({ type: MESSAGE_IMAGES, images: scoped }, location.origin);
    window.postMessage({
      type: MESSAGE_STATUS,
      status: "captured",
      total: records.size,
      capture_count: captureCount
    }, location.origin);
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
    return rect.bottom > window.innerHeight * 0.72 && rect.height < 220;
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

          // 会话主区图片：替换水印的同时入库。新对话流式包常不含 chatId，仅靠 JSON.parse 会漏检。
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
    window.postMessage({
      type: MESSAGE_STATUS,
      status: records.size ? "captured" : "listening",
      total: records.size,
      capture_count: captureCount,
      fiber_scanned: scannedTargets
    }, location.origin);
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
        const linkedId = new URL(linkedChat.href, location.href).pathname.match(/\/chat\/([^/?#]+)/)?.[1];
        const currentId = location.pathname.match(/\/chat\/([^/?#]+)/)?.[1];
        if (linkedId && currentId && linkedId !== currentId) return false;
      } catch (_) {
        return false;
      }
    }
    const main = document.querySelector('main, [role="main"]');
    if (main && !main.contains(img)) return false;
    const rect = img.getBoundingClientRect();
    if (rect.width < 110 || rect.height < 110) return false;
    const leftGuard = Math.min(180, window.innerWidth * 0.14);
    return rect.right > leftGuard;
  }

  JSON.parse = function doubaoOriginalImageParse(text, reviver) {
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

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === "DOUBAO_SET_ENABLED") {
      extensionEnabled = event.data.enabled !== false;
      return;
    }
    if (event.data?.type === MESSAGE_READY) {
      syncInjectedChat();
      if (extensionEnabled) postImages(Array.from(records.values()));
      window.postMessage({
        type: MESSAGE_STATUS,
        status: records.size ? "captured" : "listening",
        total: records.size,
        capture_count: captureCount
      }, location.origin);
    }
    if (event.data?.type === "DOUBAO_ORIGINAL_FIBER_SCAN") {
      if (!extensionEnabled) return;
      queueReactFiberScan(Boolean(event.data.force));
    }
  });

  const originalPushState = history.pushState;
  history.pushState = function doubaoOriginalPushState(...args) {
    const result = originalPushState.apply(this, args);
    syncInjectedChat();
    return result;
  };
  const originalReplaceState = history.replaceState;
  history.replaceState = function doubaoOriginalReplaceState(...args) {
    const result = originalReplaceState.apply(this, args);
    syncInjectedChat();
    return result;
  };
  window.addEventListener("popstate", () => syncInjectedChat());

  window.postMessage({
    type: MESSAGE_STATUS,
    status: "listening",
    total: 0,
    capture_count: 0
  }, location.origin);
})();
