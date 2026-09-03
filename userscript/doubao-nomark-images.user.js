// ==UserScript==
// @name         豆包无水印图片下载（十一木）
// @namespace    https://github.com/XiaoYu43002/DoubaoWaterMark-Remover
// @version      2.3.2
// @description  豆包对话页捕获并下载无水印原图。视频请使用同仓库 Chrome 扩展 doubaoparser（油猴无 debugger）。
// @author       十一木
// @match        https://*.doubao.com/*
// @icon         https://www.doubao.com/favicon.ico
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// @license      MIT
// @homepageURL  https://github.com/XiaoYu43002/DoubaoWaterMark-Remover
// @supportURL   https://github.com/XiaoYu43002/DoubaoWaterMark-Remover/issues
// ==/UserScript==

(() => {
  "use strict";

  if (window.__SHIYIMU_DOUBAO_USERJS__) return;
  window.__SHIYIMU_DOUBAO_USERJS__ = true;

  const records = new Map();
  const originalParse = JSON.parse;
  let panelEl = null;
  let listEl = null;
  let countEl = null;

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
      best_url: bestUrl,
      width,
      height,
      captured_at: Date.now()
    };
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
      "image_ori", "image_preview", "image_thumb", "image_watermark",
      "image_download", "download_image", "preview_image"
    ];
    for (const key of assetKeys) {
      if (obj[key]) replaceAssetUrl(obj[key], rawUrl);
    }
  }

  function mergeRecord(next) {
    const previous = records.get(next.image_id);
    if (!previous) {
      records.set(next.image_id, next);
      return true;
    }
    const merged = {
      ...previous,
      image_ori_raw_url: next.image_ori_raw_url || previous.image_ori_raw_url,
      best_url: next.image_ori_raw_url || next.best_url || previous.best_url,
      width: next.width || previous.width,
      height: next.height || previous.height
    };
    records.set(next.image_id, merged);
    return merged.best_url !== previous.best_url;
  }

  function walk(value, depth = 0) {
    if (!value || depth > 12) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;

    const record = pickRecord(value);
    if (record) {
      upgradePageImageData(value, record.image_ori_raw_url);
      if (mergeRecord(record)) scheduleRender();
    }

    if (value.image && typeof value.image === "object") {
      const nested = pickRecord(value.image);
      if (nested) {
        upgradePageImageData(value.image, nested.image_ori_raw_url);
        if (mergeRecord(nested)) scheduleRender();
      }
    }

    for (const key of Object.keys(value)) {
      try {
        const child = value[key];
        if (child && typeof child === "object") walk(child, depth + 1);
      } catch (_) {}
    }
  }

  JSON.parse = function patchedParse(text, reviver) {
    const result = originalParse.apply(this, arguments);
    try {
      walk(result);
    } catch (_) {}
    return result;
  };

  function extFromUrl(url) {
    try {
      const match = new URL(url).pathname.match(/\.(jpe?g|png|webp|avif|gif)$/i);
      return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
    } catch (_) {
      return "jpg";
    }
  }

  function downloadUrl(url, filename) {
    if (typeof GM_download === "function") {
      GM_download({ url, name: filename, saveAs: false });
      return;
    }
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function ensurePanel() {
    if (panelEl || !document.documentElement) return;
    panelEl = document.createElement("div");
    panelEl.id = "shiyimu-doubao-panel";
    panelEl.innerHTML = `
      <style>
        #shiyimu-doubao-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:280px;max-height:360px;display:flex;flex-direction:column;background:#0f172a;color:#e2e8f0;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.35);font:13px/1.4 system-ui,sans-serif;overflow:hidden}
        #shiyimu-doubao-panel header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#1d4ed8;font-weight:600}
        #shiyimu-doubao-panel header button{border:0;background:transparent;color:#fff;cursor:pointer;font-size:16px}
        #shiyimu-doubao-panel .hint{padding:8px 12px;color:#94a3b8;font-size:11px;border-bottom:1px solid #1e293b}
        #shiyimu-doubao-panel .list{overflow:auto;padding:8px;display:grid;gap:8px}
        #shiyimu-doubao-panel .item{display:flex;gap:8px;align-items:center;background:#1e293b;border-radius:8px;padding:6px}
        #shiyimu-doubao-panel img{width:48px;height:48px;object-fit:cover;border-radius:6px;background:#334155}
        #shiyimu-doubao-panel .meta{flex:1;min-width:0}
        #shiyimu-doubao-panel .meta b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        #shiyimu-doubao-panel .actions{display:flex;gap:6px;padding:8px 12px 12px}
        #shiyimu-doubao-panel .actions button{flex:1;border:0;border-radius:8px;padding:8px;cursor:pointer;background:#2563eb;color:#fff;font-weight:600}
        #shiyimu-doubao-panel.collapsed{width:auto;max-height:none}
        #shiyimu-doubao-panel.collapsed .hint,#shiyimu-doubao-panel.collapsed .list,#shiyimu-doubao-panel.collapsed .actions{display:none}
      </style>
      <header>
        <span>十一木 · 无水印图 <span id="shiyimu-count">0</span></span>
        <button type="button" id="shiyimu-toggle" title="折叠">–</button>
      </header>
      <div class="hint">油猴版仅图片。视频请装仓库 Chrome 扩展 doubaoparser。</div>
      <div class="list" id="shiyimu-list"></div>
      <div class="actions">
        <button type="button" id="shiyimu-download-all">下载全部</button>
      </div>
    `;
    document.documentElement.appendChild(panelEl);
    listEl = panelEl.querySelector("#shiyimu-list");
    countEl = panelEl.querySelector("#shiyimu-count");
    panelEl.querySelector("#shiyimu-toggle").addEventListener("click", () => {
      panelEl.classList.toggle("collapsed");
    });
    panelEl.querySelector("#shiyimu-download-all").addEventListener("click", () => {
      let i = 0;
      for (const record of records.values()) {
        i += 1;
        downloadUrl(record.best_url, `doubao_${record.image_id.slice(-24)}.${extFromUrl(record.best_url)}`);
      }
    });
  }

  let renderTimer = null;
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderPanel, 200);
  }

  function renderPanel() {
    ensurePanel();
    if (!listEl || !countEl) return;
    const items = Array.from(records.values()).sort((a, b) => b.captured_at - a.captured_at);
    countEl.textContent = String(items.length);
    listEl.innerHTML = "";
    for (const record of items.slice(0, 40)) {
      const row = document.createElement("div");
      row.className = "item";
      const img = document.createElement("img");
      img.src = record.best_url;
      img.alt = "";
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.innerHTML = `<b>${record.width || "?"}×${record.height || "?"}</b><span>原图</span>`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "下载";
      btn.style.cssText = "border:0;border-radius:6px;padding:6px 8px;background:#334155;color:#fff;cursor:pointer";
      btn.addEventListener("click", () => {
        downloadUrl(record.best_url, `doubao_${record.image_id.slice(-24)}.${extFromUrl(record.best_url)}`);
      });
      row.append(img, meta, btn);
      listEl.appendChild(row);
    }
  }

  function bootUi() {
    ensurePanel();
    renderPanel();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootUi, { once: true });
  } else {
    bootUi();
  }
})();
