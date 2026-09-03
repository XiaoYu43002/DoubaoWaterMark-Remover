(() => {
  "use strict";

  if (window.__DOUBAO_ORIGINAL_CONTENT__) return;
  window.__DOUBAO_ORIGINAL_CONTENT__ = true;

  const records = new Map();
  const sessionVideos = new Map();
  const visibleImageIds = new Set();
  const urlIndex = new Map();
  const imageRecords = new WeakMap();
  const observer = new MutationObserver(handleMutations);
  let enhanceScheduled = false;
  let enhanceTimer = null;
  let fiberScanTimer = null;
  let status = "listening";
  let lastFiberScanAt = 0;
  let sessionRescanUntil = Date.now() + 2200;
  let sessionConversationId = getConversationMeta().conversation_id;
  let extensionEnabled = true;
  let readyToastTimer = null;
  let readyToastHideTimer = null;
  let readyToastShown = false;

  const SUPPORT_URL = "https://github.com/XiaoYu43002/DoubaoWaterMark-Remover";

  const mediaPanel = createMediaPanel();
  setStatus("listening");
  bootstrapExtensionEnabled();

  function showReadyToast() {
    if (!extensionEnabled || !document.documentElement || readyToastShown) return;
    readyToastShown = true;
    clearTimeout(readyToastTimer);
    clearTimeout(readyToastHideTimer);
    const existing = document.getElementById("doubao-wm-ready-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "doubao-wm-ready-toast";
    toast.setAttribute("role", "status");
    toast.textContent = "插件已就绪 · 数据仅在本地处理";
    toast.style.cssText = [
      "position:fixed",
      "left:50%",
      "top:50%",
      "transform:translate(-50%,-50%)",
      "z-index:2147483647",
      "padding:10px 18px",
      "border-radius:999px",
      "background:rgba(28,28,30,.78)",
      "color:#fff",
      "font:13px/1.4 system-ui,\"PingFang SC\",\"Microsoft YaHei\",sans-serif",
      "letter-spacing:.02em",
      "backdrop-filter:blur(10px)",
      "-webkit-backdrop-filter:blur(10px)",
      "box-shadow:0 8px 28px rgba(0,0,0,.22)",
      "pointer-events:none",
      "opacity:0",
      "transition:opacity .28s ease"
    ].join(";");
    document.documentElement.appendChild(toast);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { toast.style.opacity = "1"; });
    });
    readyToastTimer = setTimeout(() => {
      toast.style.opacity = "0";
      readyToastHideTimer = setTimeout(() => toast.remove(), 320);
    }, 2800);
  }

  function createMediaPanel() {
    const host = document.createElement("div");
    host.id = "doubao-original-media-panel";
    host.style.cssText = "position:fixed;right:18px;bottom:24px;top:auto;z-index:2147483645;pointer-events:auto;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        *{box-sizing:border-box;font-family:Arial,"Microsoft YaHei",sans-serif}
        button{font:inherit;cursor:pointer}
        #panel{display:flex;flex-direction:column;width:326px;height:280px;max-height:320px;overflow:hidden;border:1px solid rgba(0,87,255,.18);border-radius:14px;
          background:#fff;color:#27272a;box-shadow:0 16px 40px rgba(20,45,90,.18)}
        header{display:grid;grid-template-columns:28px minmax(0,1fr) 28px;flex:0 0 auto;align-items:center;gap:9px;padding:10px 11px;background:linear-gradient(110deg,#0057ff,#2387ff);color:#fff;cursor:move;user-select:none;touch-action:none}
        header .icon{cursor:pointer}
        .title{min-width:0;text-align:center}.title strong{display:flex;align-items:center;justify-content:center;gap:6px;font-size:13px}.title strong span{display:inline;margin:0;color:#fff;font-size:13px}
        .state-dot{width:7px;height:7px;border-radius:50%;background:#35dc72;box-shadow:0 0 0 2px rgba(255,255,255,.18)}
        .icon{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:rgba(255,255,255,.18);color:#fff}
        .icon:hover{background:rgba(255,255,255,.28)}.icon svg{width:14px;height:14px;transition:transform .2s}.collapsed #collapse svg{transform:rotate(180deg)}
        #tabs{display:flex;flex:0 0 auto;padding:7px 10px 0;background:#fff;border-bottom:1px solid #e4e4e7}.tab{flex:1;height:32px;border:0;border-bottom:2px solid transparent;background:#fff;color:#71717a;font-size:11px}.tab.active{border-bottom-color:#0057ff;color:#0057ff;font-weight:700}
        #body{min-height:0;flex:1 1 auto;overflow:auto;padding:10px;background:#f7f8fa}#panel.collapsed{height:auto;max-height:none}#panel.collapsed #tabs,#panel.collapsed #body,#panel.collapsed footer{display:none}
        .empty{padding:28px 10px;text-align:center;color:#71717a;font-size:11px;line-height:1.6}
        .item{display:flex;align-items:center;gap:9px;margin-bottom:7px;padding:7px;border:1px solid #e4e4e7;border-radius:10px;background:#fff}
        .thumb{width:54px;height:54px;flex:0 0 54px;border-radius:8px;object-fit:cover;background:#e4e4e7}.info{min-width:0;flex:1}
        .info strong{display:block;font-size:11px}.info span{display:block;margin-top:4px;overflow:hidden;text-overflow:ellipsis;
          white-space:nowrap;color:#a1a1aa;font-size:9px}.download{height:29px;padding:0 9px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:10px}
        footer{display:flex;flex:0 0 auto;align-items:center;justify-content:space-between;gap:8px;padding:9px 11px;border-top:1px solid #e4e4e7;background:#fff}
        footer button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:31px;padding:0 12px;border:0;border-radius:9px;font-size:11px;font-weight:600}
        footer button svg{width:14px;height:14px;flex:0 0 auto}
        #support-author{background:#f4f4f5;color:#3f3f46}
        #support-author:hover{background:#e4e4e7}
        #support-author svg{stroke:#ef4444;fill:none}
        #download-all{background:#2563eb;color:#fff}
        #download-all svg{stroke:currentColor;fill:none}
        #download-all:disabled{opacity:.45;cursor:not-allowed}
        #launcher{display:none;width:46px;height:46px;border:0;border-radius:50%;background:#0057ff;color:#fff;font-size:20px;box-shadow:0 8px 24px rgba(0,87,255,.3)}
        #panel.closed{display:none}#panel.closed+#launcher{display:block}
      </style>
      <section id="panel">
        <header><button id="collapse" class="icon" title="收起面板" aria-label="收起或展开面板"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button><div class="title"><strong><span>加载成功</span><i class="state-dot"></i></strong></div><button id="close" class="icon" title="关闭">×</button></header>
        <nav id="tabs"><button class="tab active" data-type="image">图片 <b id="image-count">0</b></button><button class="tab" data-type="video">视频 <b id="video-count">0</b></button></nav>
        <div id="body"><div id="list"><div class="empty">当前会话暂未识别到图片</div></div></div>
        <footer>
          <button id="support-author" type="button" title="支持作者十一木">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 5.6a5.1 5.1 0 0 0-7.2 0L12 7.2l-1.6-1.6a5.1 5.1 0 0 0-7.2 7.2l1.6 1.6L12 21.2l7.2-7.2 1.6-1.6a5.1 5.1 0 0 0 0-7.2z" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span>支持作者</span>
          </button>
          <button id="download-all" type="button" disabled>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10m0 0 4-4m-4 4-4-4M5 18h14" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span>全部下载</span>
          </button>
        </footer>
      </section>
      <button id="launcher" title="打开无水印媒体面板">◈</button>
    `;

    const panel = shadow.getElementById("panel");
    const header = shadow.querySelector("header");
    const list = shadow.getElementById("list");
    const supportAuthor = shadow.getElementById("support-author");
    const downloadAll = shadow.getElementById("download-all");
    const objectUrls = new Set();
    let activeType = "image";

    enablePanelDrag(host, header);

    shadow.getElementById("collapse").addEventListener("click", (event) => {
      panel.classList.toggle("collapsed");
      event.currentTarget.title = panel.classList.contains("collapsed") ? "展开面板" : "收起面板";
    });
    shadow.getElementById("close").addEventListener("click", () => panel.classList.add("closed"));
    shadow.getElementById("launcher").addEventListener("click", () => panel.classList.remove("closed"));

    shadow.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => {
      activeType = button.dataset.type;
      render();
    }));

    supportAuthor.addEventListener("click", () => {
      window.open(SUPPORT_URL, "_blank", "noopener,noreferrer");
    });

    downloadAll.addEventListener("click", async () => {
      const items = activeType === "image"
        ? Array.from(visibleImageIds).map((imageId) => records.get(imageId)).filter(Boolean)
        : Array.from(sessionVideos.values());
      if (!items.length) return;
      downloadAll.disabled = true;
      const downloadLabel = downloadAll.querySelector("span");
      if (downloadLabel) downloadLabel.textContent = "提交中…";
      const response = await sendRuntimeMessage(activeType === "image"
        ? { type: "BATCH_DOWNLOAD", images: items }
        : { type: "BATCH_VIDEO_DOWNLOAD", videos: items });
      downloadAll.disabled = false;
      if (downloadLabel) downloadLabel.textContent = "全部下载";
      setStatus(response?.ok === false ? "error" : "captured", response?.ok === false ? response.error : `已提交 ${items.length} 项下载`);
    });

    function formatMeta(record, type) {
      const width = record.width || "?";
      const height = record.height || "?";
      const ext = String(type === "image" ? record.extension || "jpg" : record.format || "mp4").toUpperCase();
      return `${width} × ${height} · ${ext}`;
    }

    function appendItem(type, record) {
      const item = document.createElement("div");
      item.className = "item";
      const image = document.createElement("img");
      image.className = "thumb";
      image.alt = type === "image" ? "图片缩略图" : "视频封面";
      image.loading = "lazy";
      image.decoding = "async";
      if (record.thumbnail_blob instanceof Blob) {
        const url = URL.createObjectURL(record.thumbnail_blob);
        objectUrls.add(url);
        image.src = url;
      } else if (type === "image") {
        image.src = record.image_thumb_url || record.image_preview_url || record.image_ori_url || record.image_ori_raw_url || "";
      } else if (record.poster_url) image.src = record.poster_url;
      const info = document.createElement("div");
      info.className = "info";
      const name = document.createElement("strong");
      name.textContent = type === "image" ? "无水印图片" : "无水印视频";
      const meta = document.createElement("span");
      meta.textContent = formatMeta(record, type);
      if (type === "image" && (!record.width || !record.height)) {
        image.addEventListener("load", () => {
          if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
          if (!record.width || !record.height) {
            record.width = image.naturalWidth;
            record.height = image.naturalHeight;
            records.set(record.image_id, record);
          }
          meta.textContent = formatMeta(record, type);
        }, { once: true });
      }
      info.append(name, meta);
      const download = document.createElement("button");
      download.className = "download";
      download.textContent = "下载";
      download.addEventListener("click", async () => {
        download.disabled = true;
        download.textContent = "提交…";
        const response = await sendRuntimeMessage(type === "image"
          ? { type: "DOWNLOAD_IMAGE", image: record }
          : { type: "DOWNLOAD_VIDEO", video: record });
        download.disabled = false;
        download.textContent = "下载";
        setStatus(response?.ok === false ? "error" : "captured", response?.ok === false ? response.error : "下载任务已提交");
      });
      item.append(image, info, download);
      list.appendChild(item);
    }

    function render() {
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls.clear();
      list.replaceChildren();
      const images = Array.from(visibleImageIds)
        .map((imageId) => records.get(imageId))
        .filter(Boolean);
      const videos = Array.from(sessionVideos.values());
      shadow.getElementById("image-count").textContent = String(images.length);
      shadow.getElementById("video-count").textContent = String(videos.length);
      shadow.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.type === activeType));
      const items = (activeType === "image" ? images : videos).sort((a, b) => (b.captured_at || 0) - (a.captured_at || 0));
      downloadAll.disabled = items.length === 0;
      const downloadLabel = downloadAll.querySelector("span");
      if (downloadLabel) downloadLabel.textContent = "全部下载";
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = activeType === "image" ? "当前会话暂未识别到图片" : "当前会话暂未识别到视频";
        list.appendChild(empty);
      } else items.forEach((record) => appendItem(activeType, record));
    }

    const append = () => {
      if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host);
    };
    append();
    if (!host.isConnected) document.addEventListener("DOMContentLoaded", append, { once: true });
    return {
      host,
      refresh: render,
      reset: () => { activeType = "image"; render(); },
      showVideo: (record) => {
        if (!record?.video_record_id) return;
        sessionVideos.set(record.video_record_id, record);
        if (!records.size && sessionVideos.size === 1) activeType = "video";
        render();
      },
      revoke: () => objectUrls.forEach((url) => URL.revokeObjectURL(url))
    };
  }

  function broadcastEnabledToPage() {
    window.postMessage({ type: "DOUBAO_SET_ENABLED", enabled: extensionEnabled }, location.origin);
  }

  function applyExtensionEnabled() {
    broadcastEnabledToPage();
    if (mediaPanel?.host) mediaPanel.host.style.display = extensionEnabled ? "" : "none";
    if (!extensionEnabled) {
      const toast = document.getElementById("doubao-wm-ready-toast");
      if (toast) toast.remove();
      readyToastShown = false;
      setStatus("listening");
      return;
    }
    scheduleEnhance();
    requestFiberScan(false, 260);
    mediaPanel.refresh();
    showReadyToast();
  }

  function bootstrapExtensionEnabled() {
    chrome.storage.local.get({ extensionEnabled: true }, (stored) => {
      extensionEnabled = stored.extensionEnabled !== false;
      applyExtensionEnabled();
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.extensionEnabled) return;
    extensionEnabled = changes.extensionEnabled.newValue !== false;
    applyExtensionEnabled();
  });

  function enablePanelDrag(host, handle) {
    const POSITION_KEY = "doubaoMediaPanelPosition_v3";
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let moved = false;

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    function applyPosition(left, top) {
      const rect = host.getBoundingClientRect();
      const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
      const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
      const nextLeft = clamp(left, 8, maxLeft);
      const nextTop = clamp(top, 8, maxTop);
      host.style.left = `${nextLeft}px`;
      host.style.top = `${nextTop}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
      return { left: nextLeft, top: nextTop };
    }

    function restorePosition() {
      try {
        const raw = localStorage.getItem(POSITION_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (!Number.isFinite(saved?.left) || !Number.isFinite(saved?.top)) return;
        applyPosition(saved.left, saved.top);
      } catch (_) {
        // ignore broken saved position
      }
    }

    function savePosition() {
      const rect = host.getBoundingClientRect();
      try {
        localStorage.setItem(POSITION_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
      } catch (_) {
        // ignore quota / private mode failures
      }
    }

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest("button")) return;
      const rect = host.getBoundingClientRect();
      dragging = true;
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      originLeft = rect.left;
      originTop = rect.top;
      applyPosition(originLeft, originTop);
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    handle.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
      applyPosition(originLeft + dx, originTop + dy);
    });

    function endDrag(event) {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture?.(event.pointerId); } catch (_) {}
      if (moved) savePosition();
    }

    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
    window.addEventListener("resize", () => {
      const rect = host.getBoundingClientRect();
      if (host.style.left && host.style.left !== "auto") applyPosition(rect.left, rect.top);
    });

    restorePosition();
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

  function normalizeUrl(value) {
    if (!isAllowedUrl(value)) return null;
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.href;
  }

  function pathKey(value) {
    if (!isAllowedUrl(value)) return null;
    try {
      return decodeURIComponent(new URL(value).pathname)
        .replace(/\.(?:jpe?g|png|webp|avif|gif)$/i, "")
        .replace(/[^a-zA-Z0-9_-]+/g, "_")
        .slice(-180);
    } catch (_) {
      return null;
    }
  }

  function extractChatIdFromLocation() {
    const url = new URL(location.href);
    const pathMatch = url.pathname.match(/\/(?:chat|conversation)\/([^/?#]+)/i);
    const queryId = url.searchParams.get("conversation_id") || url.searchParams.get("conversationId") ||
      url.searchParams.get("chat_id") || url.searchParams.get("chatId");
    const hashMatch = url.hash.match(/(?:conversation|chat)[_/-]?(?:id)?[=/:-]([^&/?#]+)/i);
    return String(queryId || pathMatch?.[1] || hashMatch?.[1] || "").trim();
  }

  function isConcreteChatId(chatId) {
    const id = String(chatId || "").trim();
    if (!id) return false;
    if (/^(home|chat|conversation|new|index|explore|discover|bot|agent)?$/i.test(id)) return false;
    // 豆包真实会话 ID 通常是较长数字/字母串；过短的多半是路由占位。
    if (id.length < 10) return false;
    return /^[a-zA-Z0-9_-]+$/.test(id);
  }

  function isConcreteChatPage() {
    return isConcreteChatId(extractChatIdFromLocation());
  }

  function getConversationMeta() {
    const url = new URL(location.href);
    const pathId = extractChatIdFromLocation() || "home";
    const conversationId = `${url.origin}:${pathId}`.slice(0, 500);
    let rawTitle = String(document.title || "")
      .replace(/\s*[-|｜]\s*豆包.*$/i, "")
      .replace(/^豆包\s*[-|｜]?\s*/i, "")
      .replace(/字节跳动旗下.*$/i, "")
      .trim();
    if (!rawTitle || rawTitle === "豆包" || /智能助手/i.test(rawTitle)) rawTitle = "";
    const shortId = pathId.length > 16 ? pathId.slice(-10) : pathId;
    return {
      conversation_id: conversationId,
      conversation_chat_id: pathId.slice(0, 200),
      conversation_title: rawTitle ? rawTitle.slice(0, 120) : (isConcreteChatId(pathId) ? `对话 ${shortId}` : "未进入会话"),
      page_url: `${url.origin}${url.pathname}`
    };
  }

  function syncPageSession() {
    const nextId = getConversationMeta().conversation_id;
    if (nextId === sessionConversationId) return;
    sessionConversationId = nextId;
    records.clear();
    sessionVideos.clear();
    visibleImageIds.clear();
    urlIndex.clear();
    mediaPanel.reset();
    setStatus("listening");
    sessionRescanUntil = Date.now() + 2200;
    requestFiberScan(true, 450);
    scheduleConversationTitleSync();
  }

  let titleSyncTimer = null;
  function scheduleConversationTitleSync() {
    clearTimeout(titleSyncTimer);
    titleSyncTimer = setTimeout(() => {
      if (!isConcreteChatPage()) return;
      const meta = getConversationMeta();
      const title = String(meta.conversation_title || "").trim();
      if (!title || /^(未分类历史|未命名会话|未进入会话|当前会话)$/.test(title)) return;
      if (/^对话\s+\S+$/.test(title) || /智能助手|字节跳动旗下/.test(title)) return;
      sendRuntimeMessage({
        type: "UPDATE_CONVERSATION_TITLE",
        conversation_id: meta.conversation_id,
        conversation_chat_id: meta.conversation_chat_id,
        conversation_title: title
      }).catch(() => {});
    }, 1600);
  }

  function validateRecord(value) {
    if (!value || typeof value !== "object") return null;
    const urls = {
      image_ori_raw_url: isAllowedUrl(value.image_ori_raw_url) ? value.image_ori_raw_url : null,
      image_ori_url: isAllowedUrl(value.image_ori_url) ? value.image_ori_url : null,
      image_preview_url: isAllowedUrl(value.image_preview_url) ? value.image_preview_url : null,
      image_thumb_url: isAllowedUrl(value.image_thumb_url) ? value.image_thumb_url : null
    };
    // 必须有无水印原图，避免把搜索/文档截图等干扰图入库。
    if (!urls.image_ori_raw_url) return null;
    const bestUrl = urls.image_ori_raw_url || urls.image_ori_url ||
      urls.image_preview_url || urls.image_thumb_url;
    if (!bestUrl) return null;

    const rawId = typeof value.image_id === "string" ? value.image_id : pathKey(bestUrl);
    const imageId = String(rawId || pathKey(bestUrl))
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 200);
    if (!imageId) return null;

    const width = Number(value.width || value.image_width || 0);
    const height = Number(value.height || value.image_height || 0);
    let extension = typeof value.extension === "string" ? value.extension.toLowerCase() : null;
    if (!extension) {
      try {
        const match = decodeURIComponent(new URL(bestUrl).pathname).match(/\.([a-z0-9]{2,5})$/i);
        extension = match?.[1]?.toLowerCase() === "jpeg" ? "jpg" : match?.[1]?.toLowerCase() || null;
      } catch (_) {
        extension = null;
      }
    }

    return {
      image_id: imageId,
      ...urls,
      best_url: bestUrl,
      width: width > 0 ? width : 0,
      height: height > 0 ? height : 0,
      extension,
      captured_at: Number.isFinite(value.captured_at) ? value.captured_at : Date.now(),
      page_chat_id: typeof value.page_chat_id === "string" ? value.page_chat_id.slice(0, 200) : "",
      ...getConversationMeta()
    };
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

  function resolveImageIdByRawUrl(url) {
    if (!url) return null;
    const normalized = normalizeUrl(url);
    const key = pathKey(url);
    const id = (normalized && urlIndex.get(`url:${normalized}`)) ||
      (key && urlIndex.get(`path:${key}`));
    if (id && records.has(id)) return id;
    const assetKey = assetKeyFromUrl(url);
    if (assetKey) {
      const assetId = urlIndex.get(`asset:${assetKey}`);
      if (assetId && records.has(assetId)) return assetId;
    }
    return null;
  }

  function registerRecord(next) {
    const rawUrl = next.image_ori_raw_url || next.best_url;
    const existingId = resolveImageIdByRawUrl(rawUrl);
    if (existingId) next.image_id = existingId;

    const previous = records.get(next.image_id) || {};
    const merged = {
      ...previous,
      ...next,
      image_ori_raw_url: next.image_ori_raw_url || previous.image_ori_raw_url || null,
      image_ori_url: next.image_ori_url || previous.image_ori_url || null,
      image_preview_url: next.image_preview_url || previous.image_preview_url || null,
      image_thumb_url: next.image_thumb_url || previous.image_thumb_url || null
    };
    merged.best_url = merged.image_ori_raw_url || merged.image_ori_url ||
      merged.image_preview_url || merged.image_thumb_url;
    merged.width = next.width || previous.width || 0;
    merged.height = next.height || previous.height || 0;
    merged.extension = next.extension || previous.extension || null;
    records.set(merged.image_id, merged);

    for (const url of [merged.image_ori_raw_url, merged.image_ori_url,
      merged.image_preview_url, merged.image_thumb_url]) {
      const normalized = normalizeUrl(url);
      const key = pathKey(url);
      const assetKey = assetKeyFromUrl(url);
      if (normalized) urlIndex.set(`url:${normalized}`, merged.image_id);
      if (key) urlIndex.set(`path:${key}`, merged.image_id);
      if (assetKey) urlIndex.set(`asset:${assetKey}`, merged.image_id);
    }
    return merged;
  }

  function findRecordForImage(img) {
    const remembered = imageRecords.get(img);
    if (remembered && records.has(remembered)) return records.get(remembered);

    const candidates = [img.currentSrc, img.src, img.getAttribute("src")].filter(Boolean);
    for (const value of candidates) {
      const normalized = normalizeUrl(value);
      const key = pathKey(value);
      const id = (normalized && urlIndex.get(`url:${normalized}`)) ||
        (key && urlIndex.get(`path:${key}`));
      if (id && records.has(id)) {
        imageRecords.set(img, id);
        return records.get(id);
      }
    }
    return null;
  }

  function setStatus(next) {
    status = next;
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(response || { ok: true });
      });
    });
  }

  async function handleCapturedImages(values) {
    if (!extensionEnabled) return;
    syncPageSession();
    // 首页 / 未进入具体会话时不入库，避免把推荐位、示例图扫进「未命名会话」。
    if (!isConcreteChatPage()) return;
    const capturedForConversation = sessionConversationId;
    const currentChat = extractChatIdFromLocation();
    const valid = values.slice(0, 200)
      .filter((raw) => !(raw?.page_chat_id && raw.page_chat_id !== currentChat))
      .map(validateRecord)
      .filter(Boolean);
    if (!valid.length) return;
    const changed = [];
    for (const next of valid) {
      const previous = records.get(next.image_id);
      const merged = registerRecord(next);
      if (!previous ||
          previous.image_ori_raw_url !== merged.image_ori_raw_url ||
          previous.image_ori_url !== merged.image_ori_url ||
          previous.image_preview_url !== merged.image_preview_url ||
          previous.image_thumb_url !== merged.image_thumb_url ||
          previous.conversation_id !== merged.conversation_id ||
          previous.conversation_title !== merged.conversation_title) {
        changed.push(merged);
      }
    }
    setStatus("loading");
    scheduleEnhance();
    mediaPanel.refresh();

    if (!changed.length) {
      setStatus("captured");
      mediaPanel.refresh();
      return;
    }

    const response = await sendRuntimeMessage({ type: "DOUBAO_IMAGES", images: changed });
    if (capturedForConversation !== sessionConversationId) return;
    if (response?.ok === false) setStatus("error", `原图处理失败：${response.error || "未知错误"}`);
    else {
      for (const result of response.results || []) {
        if (!result?.ok || !result.image?.image_id || !records.has(result.image.image_id)) continue;
        // 背景若保留了其它会话归属，不要覆盖进当前页面板。
        if (result.image.conversation_id &&
            result.image.conversation_id !== sessionConversationId &&
            result.image.conversation_chat_id &&
            result.image.conversation_chat_id !== currentChat) {
          records.delete(result.image.image_id);
          continue;
        }
        registerRecord(result.image);
      }
      setStatus("captured");
    }
    mediaPanel.refresh();
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === "DOUBAO_CHAT_CHANGED") {
      syncPageSession();
      if (extensionEnabled && isConcreteChatPage()) {
        sessionRescanUntil = Date.now() + 4000;
        requestFiberScan(true, 60);
        scheduleEnhance(30);
      }
      return;
    }
    if (event.data?.type === "DOUBAO_ORIGINAL_IMAGES" && Array.isArray(event.data.images)) {
      handleCapturedImages(event.data.images);
    }
    if (event.data?.type === "DOUBAO_ORIGINAL_STATUS" &&
        event.data.status === "listening" && !records.size) {
      setStatus("listening");
    }
  });

  function nodeContainsImage(node) {
    if (!(node instanceof Element)) return false;
    const selector = "img";
    return node.matches(selector) || Boolean(node.querySelector(selector));
  }

  function handleMutations(mutations) {
    syncPageSession();
    const touchesMedia = mutations.some((mutation) => {
      if (mutation.type === "attributes") return mutation.target instanceof HTMLImageElement;
      return Array.from(mutation.addedNodes).some(nodeContainsImage) ||
        Array.from(mutation.removedNodes).some(nodeContainsImage);
    });
    if (touchesMedia) {
      scheduleEnhance(45);
      if (Date.now() < sessionRescanUntil) requestFiberScan(true, 90);
    }
  }

  function scheduleEnhance(delay = 35) {
    if (!extensionEnabled) return;
    syncPageSession();
    if (enhanceScheduled) return;
    enhanceScheduled = true;
    enhanceTimer = setTimeout(() => {
      enhanceScheduled = false;
      enhanceTimer = null;
      enhanceImages();
    }, delay);
  }

  function requestFiberScan(force = false, delay = 120) {
    if (!extensionEnabled) return;
    if (!isConcreteChatPage()) return;
    if (!force && (fiberScanTimer || Date.now() - lastFiberScanAt < 1800)) return;
    clearTimeout(fiberScanTimer);
    fiberScanTimer = setTimeout(() => {
      fiberScanTimer = null;
      lastFiberScanAt = Date.now();
      window.postMessage({ type: "DOUBAO_ORIGINAL_FIBER_SCAN", force }, location.origin);
    }, delay);
  }

  function enhanceImages() {
    if (!extensionEnabled || !document.body) return;
    const images = document.querySelectorAll('img[src*="byteimg.com"], img[srcset*="byteimg.com"]');
    const nextVisibleIds = new Set();
    let unmatched = 0;
    let metaUpdated = false;
    for (const img of images) {
      if (img.naturalWidth && img.naturalWidth < 96) continue;
      if (!isConversationMediaImage(img)) continue;
      const record = findRecordForImage(img);
      if (!record) {
        unmatched += 1;
        continue;
      }
      // 面板与增强只处理当前会话记录，避免其它会话图片串进来。
      if (record.conversation_id && record.conversation_id !== sessionConversationId) continue;
      if (record.conversation_chat_id) {
        const currentChat = extractChatIdFromLocation();
        if (currentChat && record.conversation_chat_id !== currentChat) continue;
      }
      imageRecords.set(img, record.image_id);
      nextVisibleIds.add(record.image_id);

      if (img.naturalWidth > 0 && img.naturalHeight > 0 &&
          (record.width !== img.naturalWidth || record.height !== img.naturalHeight)) {
        record.width = img.naturalWidth;
        record.height = img.naturalHeight;
        records.set(record.image_id, record);
        metaUpdated = true;
      }

      const displayUrl = record.image_ori_raw_url || record.image_ori_url;
      if (displayUrl && img.src !== displayUrl) {
        img.removeAttribute("srcset");
        img.src = displayUrl;
      }
      retargetNearbyDownloadLinks(img, record);
    }

    const visibilityChanged = nextVisibleIds.size !== visibleImageIds.size ||
      Array.from(nextVisibleIds).some((imageId) => !visibleImageIds.has(imageId));
    visibleImageIds.clear();
    nextVisibleIds.forEach((imageId) => visibleImageIds.add(imageId));
    if (visibilityChanged || metaUpdated) mediaPanel.refresh();

    if (unmatched) requestFiberScan(false, 120);
  }

  function isConversationMediaImage(img) {
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
    if (rect.right <= leftGuard) return false;
    if (isComposerOrInputImage(img)) return false;
    return true;
  }

  function retargetNearbyDownloadLinks(img, record) {
    const rawUrl = record.image_ori_raw_url || record.image_ori_url;
    if (!rawUrl) return;
    let container = img.parentElement;
    for (let level = 0; container && level < 5; level += 1, container = container.parentElement) {
      const links = container.querySelectorAll('a[download], a[href*="byteimg.com"]');
      for (const link of links) {
        if (looksLikeDownloadControl(link) && link.href !== rawUrl) link.href = rawUrl;
      }
      if (links.length) break;
    }
  }

  function controlLabel(control) {
    return [
      control.getAttribute("aria-label"),
      control.getAttribute("title"),
      control.getAttribute("data-testid"),
      control.getAttribute("data-e2e"),
      control.getAttribute("download"),
      control.textContent
    ].filter(Boolean).join(" ").trim().toLowerCase();
  }

  function looksLikeDownloadControl(control) {
    return /下载|保存|download|save/.test(controlLabel(control));
  }

  function matchedImagesInside(container) {
    const candidates = container.querySelectorAll?.('img[src*="byteimg.com"], img[srcset*="byteimg.com"]') || [];
    const matched = [];
    for (const img of candidates) {
      const record = findRecordForImage(img);
      if (record?.image_ori_raw_url || record?.image_ori_url) matched.push({ img, record });
    }
    return matched;
  }

  function findImageForControl(control) {
    const controlRect = control.getBoundingClientRect();
    let container = control.parentElement;

    for (let level = 0; container && level < 7; level += 1, container = container.parentElement) {
      const matched = matchedImagesInside(container);
      if (!matched.length) continue;
      if (matched.length === 1) return matched[0];

      matched.sort((a, b) => {
        const rectA = a.img.getBoundingClientRect();
        const rectB = b.img.getBoundingClientRect();
        const distanceA = Math.abs(rectA.left - controlRect.left) + Math.abs(rectA.bottom - controlRect.top);
        const distanceB = Math.abs(rectB.left - controlRect.left) + Math.abs(rectB.bottom - controlRect.top);
        return distanceA - distanceB;
      });
      return matched[0];
    }
    return null;
  }

  document.addEventListener("click", async (event) => {
    if (!extensionEnabled) return;
    const control = event.target.closest?.('button, a, [role="button"]');
    if (!control || !looksLikeDownloadControl(control)) return;
    const matched = findImageForControl(control);
    if (!matched) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    const response = await sendRuntimeMessage({ type: "DOWNLOAD_IMAGE", image: matched.record });
    if (response?.ok === false) setStatus("error", response.error || "原图下载失败");
    else setStatus("captured", "已提交无水印原图下载");
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "EXTENSION_ENABLED_CHANGED") {
      extensionEnabled = message.enabled !== false;
      applyExtensionEnabled();
      sendResponse?.({ ok: true });
      return false;
    }
    if (message?.type === "DOUBAO_SESSION_VIDEO") {
      if (!extensionEnabled) return false;
      syncPageSession();
      if (message.video?.conversation_id === sessionConversationId) mediaPanel.showVideo(message.video);
      return false;
    }
    if (message?.type === "GET_STATUS") {
      sendResponse({
        ok: true,
        status,
        total: records.size,
        hookActive: extensionEnabled,
        enabled: extensionEnabled,
        ...getConversationMeta()
      });
      return false;
    }
    if (message?.type === "COLLECT_IMAGES") {
      sendResponse({ ok: true, images: extensionEnabled ? Array.from(records.values()) : [] });
      return false;
    }
    return false;
  });

  function start() {
    if (document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "srcset"]
      });
    }
    broadcastEnabledToPage();
    window.postMessage({ type: "DOUBAO_ORIGINAL_BRIDGE_READY" }, location.origin);
    if (extensionEnabled) {
      requestFiberScan(false, 260);
      scheduleEnhance();
      mediaPanel.refresh();
    }
    scheduleConversationTitleSync();
    const titleEl = document.querySelector("title");
    if (titleEl) {
      new MutationObserver(() => scheduleConversationTitleSync())
        .observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
  }

  window.addEventListener("pagehide", () => {
    clearTimeout(enhanceTimer);
    clearTimeout(fiberScanTimer);
    mediaPanel.revoke();
  }, { once: true });

  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
