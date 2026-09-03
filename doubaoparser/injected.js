(() => {
  "use strict";

  if (window.__DOUBAO_ORIGINAL_IMAGE_HOOK__) return;
  window.__DOUBAO_ORIGINAL_IMAGE_HOOK__ = true;

  const MESSAGE_IMAGES = "DOUBAO_ORIGINAL_IMAGES";
  const MESSAGE_STATUS = "DOUBAO_ORIGINAL_STATUS";
  const MESSAGE_READY = "DOUBAO_ORIGINAL_BRIDGE_READY";
  const records = new Map();
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
    return false;
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
      captured_at: Date.now()
    };
  }

  function pickCreationImage(item) {
    if (!item || typeof item !== "object") return null;
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
    const previous = records.get(next.image_id);
    if (!previous) {
      records.set(next.image_id, next);
      return next;
    }

    const merged = {
      ...previous,
      image_ori_raw_url: next.image_ori_raw_url || previous.image_ori_raw_url,
      image_ori_url: next.image_ori_url || previous.image_ori_url,
      image_preview_url: next.image_preview_url || previous.image_preview_url,
      image_thumb_url: next.image_thumb_url || previous.image_thumb_url,
      captured_at: Math.min(previous.captured_at, next.captured_at)
    };
    merged.best_url = merged.image_ori_raw_url || merged.image_ori_url ||
      merged.image_preview_url || merged.image_thumb_url;
    records.set(next.image_id, merged);
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
      boundChatId = chatId;
      captureCount = 0;
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

      // Fiber 只负责替换页面水印地址，不把深扫到的其它会话图片入库。
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

          let foundCount = 0;
          if (name.startsWith("__reactProps$")) {
            foundCount = scanObject(reactValue, 240, { persist: false, requireChatScope: false });
          } else {
            let fiber = reactValue;
            const visitedFibers = new WeakSet();
            for (let fiberLevel = 0; fiber && fiberLevel < 4; fiberLevel += 1) {
              if (typeof fiber !== "object" || visitedFibers.has(fiber)) break;
              visitedFibers.add(fiber);
              if (fiber.memoizedProps) {
                foundCount += scanObject(fiber.memoizedProps, 240, { persist: false, requireChatScope: false });
              }
              if (fiber.pendingProps && fiber.pendingProps !== fiber.memoizedProps) {
                foundCount += scanObject(fiber.pendingProps, 160, { persist: false, requireChatScope: false });
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
      // 必须同时带有当前会话 ID，避免刷新时把其它接口里的图写进当前会话。
      if (
        isConcreteChatPage() &&
        chatId &&
        typeof text === "string" &&
        text.includes(chatId) &&
        text.includes("image_ori_raw") &&
        (text.includes("creations") || text.includes('"image_ori"'))
      ) {
        captureCount += 1;
        scanObject(result, 9000, { persist: true, requireChatScope: true });
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
