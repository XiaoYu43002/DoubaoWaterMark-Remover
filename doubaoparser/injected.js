(() => {
  "use strict";

  if (window.__DOUBAO_ORIGINAL_IMAGE_HOOK__) return;
  window.__DOUBAO_ORIGINAL_IMAGE_HOOK__ = true;

  const MESSAGE_IMAGES = "DOUBAO_ORIGINAL_IMAGES";
  const MESSAGE_STATUS = "DOUBAO_ORIGINAL_STATUS";
  const MESSAGE_READY = "DOUBAO_ORIGINAL_BRIDGE_READY";
  const MESSAGE_VIDEO_FALLBACKS = "DOUBAO_VIDEO_FALLBACKS";
  const records = new Map();
  const rawUrlIndex = new Map();
  const assetKeyIndex = new Map();
  const videoFallbackKeys = new Set();
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

  function isConcreteChatId(chatId) {
    const id = String(chatId || "").trim();
    if (!id || id.length < 10) return false;
    if (/^(home|chat|conversation|new|index|explore|discover|bot|agent|pending)$/i.test(id)) return false;
    return /^[a-zA-Z0-9_-]+$/.test(id);
  }

  function isConcreteChatPage() {
    return isConcreteChatId(getPageChatId());
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

  // 新建对话时 URL 常晚于首包；不再做跨包 pending 缓存，避免把其它接口 creations 冲进新会话。
  let boundChatId = getPageChatId();

  function isConcreteBoundChat() {
    return isConcreteChatId(boundChatId);
  }

  function syncInjectedChat() {
    const chatId = getPageChatId();
    if (chatId !== boundChatId) {
      records.clear();
      rawUrlIndex.clear();
      assetKeyIndex.clear();
      videoFallbackKeys.clear();
      boundChatId = chatId;
      captureCount = 0;
      window.postMessage({ type: "DOUBAO_CHAT_CHANGED", chat_id: chatId }, location.origin);
      // 从首页进入新建会话时，URL 落地后立刻补扫当前页已渲染的图。
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

  function objectHasForeignChat(obj, chatId) {
    if (!obj || typeof obj !== "object" || !chatId) return false;
    const keys = [
      "conversation_id", "conversationId", "chat_id", "chatId", "cid",
      "conversation_chat_id", "bot_conversation_id"
    ];
    for (const key of keys) {
      try {
        const raw = obj[key];
        if (raw == null || raw === "") continue;
        const value = String(raw).trim();
        if (value.length < 10 || value === chatId) continue;
        if (/^(home|chat|conversation|new|index|explore|discover|bot|agent|pending)$/i.test(value)) continue;
        if (/^[a-zA-Z0-9_-]+$/.test(value)) return true;
      } catch (_) {}
    }
    return false;
  }

  function resolveChildScope(parentInScope, child, chatId, requireChatScope) {
    if (!requireChatScope) return parentInScope;
    if (objectMatchesChat(child, chatId)) return true;
    // 子节点显式属于其它会话时，切断继承，避免「当前会话节点下挂了全局缓存」整包入库。
    if (objectHasForeignChat(child, chatId)) return false;
    return parentInScope;
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
    const scoped = images.filter((item) => {
      if (!item || typeof item !== "object") return false;
      const pageChat = String(item.page_chat_id || "").trim();
      // 必须绑定当前会话；拒绝 pending / 空 / 其它会话。
      if (!pageChat || pageChat === "pending" || pageChat !== chatId) return false;
      return true;
    });
    if (!scoped.length) return;
    window.postMessage({ type: MESSAGE_IMAGES, images: scoped }, location.origin);
    window.postMessage({
      type: MESSAGE_STATUS,
      status: "captured",
      total: records.size,
      capture_count: captureCount
    }, location.origin);
  }

  function candidateMatchesAssetKeys(candidate, keys) {
    // 空集合表示「必须命中可见图」；不能当成匹配全部，否则刷新大包会串会话。
    if (!keys || !keys.size) return false;
    for (const url of [
      candidate?.image_ori_raw_url,
      candidate?.image_ori_url,
      candidate?.image_preview_url,
      candidate?.image_thumb_url,
      candidate?.best_url
    ]) {
      const key = assetKeyFromUrl(url);
      if (key && keys.has(key)) return true;
    }
    return false;
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
          if (candidate.image_ori_raw_url && item?.image) {
            upgradePageImageData(item.image, candidate.image_ori_raw_url);
          } else if (candidate.image_ori_raw_url) {
            upgradePageImageData(item, candidate.image_ori_raw_url);
          }
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
    collectCreationImages(root, "", chatId, found, { left: 48 });
    postImages(found.slice(0, 48));
    return found.length;
  }

  function canPersistUnscopedPayload(text, chatId) {
    if (!text || !chatId) return false;
    if (!text.includes("creations") || !text.includes("image_ori_raw")) return false;
    // 仅按「是否属于当前会话」判断：历史列表大包拒绝；显式其它会话字段拒绝。
    if (text.length > 180000) return false;
    if (/message_list|has_more|conversation_list|history_message|recent_chat|chat_list|sidebar/i.test(text)) {
      return false;
    }
    const idPattern = /"(?:conversation_id|conversationId|chat_id|chatId)"\s*:\s*"?([a-zA-Z0-9_-]{10,})"?/g;
    let match;
    while ((match = idPattern.exec(text))) {
      if (match[1] && match[1] !== chatId) return false;
    }
    return true;
  }

  function scanObject(root, maxInspected = 9000, options = {}) {
    if (!extensionEnabled) return 0;
    if (!root || typeof root !== "object") return 0;
    syncInjectedChat();
    const chatId = boundChatId;
    const persist = options.persist !== false;
    const forcePost = Boolean(options.forcePost);
    const matchAssetKeys = options.matchAssetKeys instanceof Set ? options.matchAssetKeys : null;
    const requireAssetMatch = matchAssetKeys instanceof Set;
    // 响应里必须能定位到当前会话 ID，才允许入库；否则只可能是其它接口的图。
    const wantScope = options.requireChatScope !== false && Boolean(chatId) && persist && isConcreteChatId(chatId);
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

      let inScope = currentFrame.inScope || objectMatchesChat(current, chatId);
      if (requireChatScope && objectHasForeignChat(current, chatId) && !objectMatchesChat(current, chatId)) {
        inScope = false;
      }

      // 优先从 creations 数组提取真正的 AI 生成图。
      if (inScope && Array.isArray(current)) {
        let creationHits = 0;
        for (const item of current) {
          const candidate = pickCreationImage(item);
          if (!candidate) continue;
          if (requireAssetMatch && !candidateMatchesAssetKeys(candidate, matchAssetKeys)) continue;
          if (!persist && !forcePost) {
            if (candidate.image_ori_raw_url && item?.image) {
              upgradePageImageData(item.image, candidate.image_ori_raw_url);
            } else if (candidate.image_ori_raw_url) {
              upgradePageImageData(item, candidate.image_ori_raw_url);
            }
            creationHits += 1;
            continue;
          }
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
          if (changed) found.push(changed);
          else if (forcePost) found.push(records.get(candidate.image_id) || candidate);
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
        if (candidate && !(requireAssetMatch && !candidateMatchesAssetKeys(candidate, matchAssetKeys))) {
          if (!persist && !forcePost) {
            if (candidate.image_ori_raw_url) upgradePageImageData(current, candidate.image_ori_raw_url);
          } else {
            candidate.page_chat_id = chatId;
            const changed = mergeRecord(candidate);
            if (changed) found.push(changed);
            else if (forcePost) found.push(records.get(candidate.image_id) || candidate);
            if (candidate.image_ori_raw_url) {
              upgradePageImageData(current, candidate.image_ori_raw_url);
            }
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
      for (const value of fallback) {
        stack.push({ value, inScope: resolveChildScope(inScope, value, chatId, requireChatScope) });
      }
      for (const value of priority) {
        stack.push({ value, inScope: resolveChildScope(inScope, value, chatId, requireChatScope) });
      }
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

  function collectImgAssetKeys(img) {
    const keys = new Set();
    const add = (value) => {
      if (typeof value !== "string" || !value) return;
      for (const part of value.split(/[\s,]+/)) {
        if (!part || part.endsWith("w") || /^\d+(\.\d+)?x?$/i.test(part)) continue;
        const key = assetKeyFromUrl(part);
        if (key) keys.add(key);
      }
    };
    add(img.currentSrc);
    add(img.src);
    add(img.getAttribute("src"));
    add(img.getAttribute("srcset"));
    return keys;
  }

  function scanReactFiber(force = false) {
    if (!isConcreteChatPage()) return;
    syncInjectedChat();
    // 强制补扫（页面已出现未匹配图）用更短间隔，避免新对话等 2–3 秒才去水印。
    const minGap = force ? 80 : 700;
    if (Date.now() - lastFiberScanAt < minGap) return;
    lastFiberScanAt = Date.now();

    const images = Array.from(document.querySelectorAll('img[src*="byteimg.com"], img[srcset*="byteimg.com"]'))
      .filter(isLikelyConversationImage)
      .slice(0, 24);
    const scannedReactValues = new WeakSet();
    let scannedTargets = 0;

    for (const img of images) {
      let node = img;
      let imageScanned = false;
      let perImageScans = 0;
      const allowPersist = shouldPersistFiberImage(img);
      const matchAssetKeys = collectImgAssetKeys(img);

      // Fiber 负责替换水印；仅把「与当前 img 同源」的 creations 入库，避免父级 props 里串进其它会话。
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
          perImageScans += 1;
          if (perImageScans > 4) break;

          const fiberScanOpts = {
            persist: allowPersist && matchAssetKeys.size > 0,
            requireChatScope: false,
            matchAssetKeys,
            forcePost: false
          };
          let foundCount = 0;
          if (name.startsWith("__reactProps$")) {
            foundCount = scanObject(reactValue, 320, fiberScanOpts);
          } else {
            let fiber = reactValue;
            const visitedFibers = new WeakSet();
            // 只向上两层，降低扫到会话列表/缓存 props 的概率。
            for (let fiberLevel = 0; fiber && fiberLevel < 2; fiberLevel += 1) {
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
        if (imageScanned || perImageScans > 4) break;
      }
    }

    // 只依赖 scanObject/scanCreationsOnly 已 post 的增量；不要把内存全量再冲一遍。
    const scopedCount = Array.from(records.values()).filter((item) =>
      item && String(item.page_chat_id || "") === boundChatId
    ).length;
    window.postMessage({
      type: MESSAGE_STATUS,
      status: scopedCount ? "captured" : "listening",
      total: scopedCount,
      capture_count: captureCount,
      fiber_scanned: scannedTargets
    }, location.origin);
  }

  function queueReactFiberScan(force = false) {
    pendingFiberForce = pendingFiberForce || force;
    if (fiberIdleHandle !== null) {
      if (!force) return;
      clearTimeout(fiberIdleHandle);
      if (typeof cancelIdleCallback === "function") {
        try { cancelIdleCallback(fiberIdleHandle); } catch (_) {}
      }
      fiberIdleHandle = null;
    }
    const run = () => {
      fiberIdleHandle = null;
      const shouldForce = pendingFiberForce;
      pendingFiberForce = false;
      scanReactFiber(shouldForce);
    };
    // 强制扫描尽快执行；空闲扫描可稍等，避免拖慢页面。
    if (pendingFiberForce) {
      fiberIdleHandle = setTimeout(run, 0);
    } else if (typeof requestIdleCallback === "function") {
      fiberIdleHandle = requestIdleCallback(run, { timeout: 320 });
    } else {
      fiberIdleHandle = setTimeout(run, 40);
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
    window.postMessage({ type: MESSAGE_VIDEO_FALLBACKS, items: results }, location.origin);
  }

  function inspectChainResponseText(text, expectedChatId) {
    // 与油猴一致：chain 只提取视频 fallback，不在此扫图片（避免历史大包串会话）。
    if (typeof text !== "string" || !text.includes("fallback_api")) return;
    syncInjectedChat();
    if (!expectedChatId || expectedChatId !== getPageChatId() || expectedChatId !== boundChatId) return;
    let payload = null;
    try {
      payload = originalParse.call(JSON, text);
    } catch (_) {
      // 分段文本仍可用正则提取 fallback_api。
    }
    collectVideoFallbacks(payload, text, expectedChatId);
  }

  JSON.parse = function doubaoOriginalImageParse(text, reviver) {
    const result = originalParse.call(this, text, reviver);
    try {
      if (!extensionEnabled) return result;
      syncInjectedChat();
      const chatId = boundChatId;
      // 严格按会话归属入库：有当前会话标记 → 只扫属于该会话的子树；
      // 无标记的流式小包 → 仅当不含其它会话字段时，记入当前 boundChatId。
      if (
        isConcreteBoundChat() &&
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
      console.debug("[Doubao Original] 解析媒体数据失败", error);
    }
    return result;
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function doubaoOriginalFetch(...args) {
      const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      const isChainRequest = String(requestUrl).includes("/im/chain/single");
      const requestChatId = isChainRequest ? getPageChatId() : "";
      const response = await originalFetch.apply(this, args);
      try {
        if (extensionEnabled && isChainRequest && requestChatId) {
          response.clone().text().then((text) => inspectChainResponseText(text, requestChatId)).catch(() => {});
        }
      } catch (_) {}
      return response;
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR?.prototype) {
    const originalOpen = XHR.prototype.open;
    XHR.prototype.open = function doubaoOriginalXhrOpen(method, url, ...rest) {
      this.__doubaoOriginalUrl = String(url || "");
      if (this.__doubaoOriginalUrl.includes("/im/chain/single")) {
        this.addEventListener("load", () => {
          try {
            if (extensionEnabled && typeof this.responseText === "string") {
              inspectChainResponseText(this.responseText, this.__doubaoOriginalChatId);
            }
          } catch (_) {}
        }, { once: true });
      }
      return originalOpen.call(this, method, url, ...rest);
    };
    const originalSend = XHR.prototype.send;
    XHR.prototype.send = function doubaoOriginalXhrSend(...args) {
      if (this.__doubaoOriginalUrl?.includes("/im/chain/single")) {
        this.__doubaoOriginalChatId = getPageChatId();
      }
      return originalSend.apply(this, args);
    };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === "DOUBAO_SET_ENABLED") {
      extensionEnabled = event.data.enabled !== false;
      return;
    }
    if (event.data?.type === MESSAGE_READY) {
      syncInjectedChat();
      // 不在 ready 时全量回传 records，避免把上一轮残留冲进页面。
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
