"use strict";

/** 反馈微信号：点击右上角联系图标后复制。请改成你的真实微信号。 */
const WECHAT_ID = "请填写微信号";

const elements = Object.fromEntries([
  "gallery", "count", "conversation-filter",
  "clear-all", "video-status", "reconnect-video", "status-chip",
  "contact-btn", "media-tabs",
  "toolbar", "select-all", "selected-count", "batch-download", "notice", "loading",
  "empty", "error"
].map((id) => [id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), document.getElementById(id)]));

const selected = new Set();
const objectUrls = new Set();
let media = [];
let mediaKind = "all";
let activeConversationId = null;
let activeConversationTitle = null;
let noticeTimer = null;
let reloadTimer = null;
let renderVersion = 0;

function sendMessage(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
    else resolve(response || { ok: true });
  }));
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => chrome.tabs.sendMessage(tabId, message, (response) => {
    if (chrome.runtime.lastError) resolve(null);
    else resolve(response || null);
  }));
}

function normalizeImage(record) {
  return { type: "image", key: `image:${record.image_id}`, record };
}

function normalizeVideo(record) {
  return { type: "video", key: `video:${record.video_record_id}`, record };
}

function conversationId(item) {
  return item.record.conversation_id || "legacy";
}

function conversationChatId(item) {
  const record = item.record;
  if (record.conversation_chat_id) return String(record.conversation_chat_id);
  const pageMatch = String(record.page_url || "").match(/\/(?:chat|conversation)\/([^/?#]+)/i);
  if (pageMatch?.[1]) return pageMatch[1];
  const internalMatch = String(record.conversation_id || "").match(/:([^:]+)$/);
  return internalMatch?.[1] && internalMatch[1] !== "legacy" ? internalMatch[1] : "";
}

function conversationTitle(item) {
  const chatId = conversationChatId(item);
  if (!chatId) return "未分类历史";
  let title = String(item.record.conversation_title || "").trim();
  if (!title || title === "未分类历史" || title === `对话 ${chatId}` || /^对话\s+[a-zA-Z0-9_-]+$/.test(title)) title = "未命名会话";
  return `${title} - ${chatId}`;
}

function activeChatId() {
  if (!activeConversationId) return "";
  return String(activeConversationId).split(":").pop() || "";
}

function belongsToSelectedConversation(item, selectedId) {
  if (!selectedId || selectedId === "all") return true;
  if (conversationId(item) === selectedId) return true;
  // 当前会话：允许用 chat id 精确兼容旧记录，但不把其他会话混进来。
  if (selectedId === activeConversationId) {
    const selectedChat = activeChatId();
    const itemChat = conversationChatId(item);
    return Boolean(selectedChat && itemChat && selectedChat === itemChat && selectedChat !== "home");
  }
  return false;
}

function visibleMedia() {
  const conversation = elements.conversationFilter.value;
  return media.filter((item) =>
    belongsToSelectedConversation(item, conversation) &&
    (mediaKind === "all" || item.type === mediaKind)
  );
}

function showNotice(text, isError = false, duration = 3500) {
  clearTimeout(noticeTimer);
  elements.notice.hidden = false;
  elements.notice.classList.toggle("error", isError);
  elements.notice.textContent = text;
  if (duration) noticeTimer = setTimeout(() => { elements.notice.hidden = true; }, duration);
}

function setMediaKind(kind) {
  mediaKind = kind === "image" || kind === "video" ? kind : "all";
  elements.mediaTabs.querySelectorAll(".media-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.kind === mediaKind);
  });
}

async function loadCaptureStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const imageStatus = tab?.id ? await sendTabMessage(tab.id, { type: "GET_STATUS" }) : null;
  const videoStatus = await sendMessage({ type: "GET_VIDEO_STATUS" });

  const conversation = videoStatus?.conversation || imageStatus;
  activeConversationId = conversation?.conversation_id || null;
  if (conversation) activeConversationTitle = conversationTitle({ record: {
    conversation_id: conversation.conversation_id,
    conversation_chat_id: conversation.chat_id || conversation.conversation_chat_id,
    conversation_title: conversation.title || conversation.conversation_title,
    page_url: conversation.page_url
  }});

  const onTarget = Boolean(tab?.id && (imageStatus?.hookActive || videoStatus?.target_page));
  document.body.dataset.captureState = onTarget ? "connected" : "error";
  renderConnectionStatus({
    onTarget,
    attached: Boolean(videoStatus?.attached),
    error: videoStatus?.error || ""
  });
}

function renderConnectionStatus({ onTarget, attached, error }) {
  const label = elements.videoStatus.querySelector("b");
  elements.videoStatus.classList.remove("connected", "error");
  if (!onTarget) {
    elements.statusChip.dataset.state = "error";
    elements.videoStatus.classList.add("error");
    if (label) label.textContent = "未就绪";
    return;
  }
  if (attached) {
    elements.statusChip.dataset.state = "connected";
    elements.videoStatus.classList.add("connected");
    if (label) label.textContent = "已连接";
    return;
  }
  elements.statusChip.dataset.state = "error";
  elements.videoStatus.classList.add("error");
  if (label) label.textContent = error ? "已断开" : "未连接";
}

async function loadCaptureMode() {
  // 捕获范围固定为当前会话，界面不再展示切换。
  await sendMessage({ type: "SET_CAPTURE_MODE", captureMode: "current_only" });
}

async function loadMedia(options = {}) {
  if (!options.silent) elements.loading.hidden = false;
  elements.error.hidden = true;
  try {
    await pruneImplausibleImages().catch(() => 0);
    const [imageRecords, videoRecords] = await Promise.all([getAllImages(), getAllVideos()]);
    media = [
      ...imageRecords.filter(isPlausibleStoredImage).map(normalizeImage),
      ...videoRecords.map(normalizeVideo)
    ].sort((a, b) => (b.record.captured_at || 0) - (a.record.captured_at || 0));
    buildConversationFilter(options.keepFilter !== false, options.preferCurrent === true);
    render();
    elements.clearAll.disabled = media.length === 0;
  } catch (error) {
    elements.loading.hidden = true;
    elements.error.hidden = false;
    elements.error.textContent = `加载失败：${error.message}`;
  }
}

function resolvePreferredConversationId(groups) {
  if (!activeConversationId) return null;
  const activeChat = activeChatId();
  if (!activeChat || activeChat.length < 10 || /^(home|chat|conversation|legacy)$/i.test(activeChat)) {
    return null;
  }
  if (groups.has(activeConversationId)) return activeConversationId;
  for (const id of groups.keys()) {
    if (id === activeChat || id.endsWith(`:${activeChat}`)) return id;
  }
  for (const item of media) {
    if (conversationChatId(item) === activeChat) return conversationId(item);
  }
  return activeConversationId;
}

function pickGroupTitle(group) {
  const activeChat = activeChatId();
  if (activeChat && group.chat === activeChat && activeConversationTitle) {
    return activeConversationTitle;
  }
  let bestTitle = group.title;
  let bestCount = -1;
  for (const [title, count] of group.titleVotes.entries()) {
    if (count > bestCount) {
      bestCount = count;
      bestTitle = title;
    }
  }
  return bestTitle || group.title || "未命名会话";
}

function buildConversationFilter(keepFilter, preferCurrent) {
  const previous = keepFilter ? elements.conversationFilter.value : "all";
  const groups = new Map();
  for (const item of media) {
    const id = conversationId(item);
    const chat = conversationChatId(item);
    // 不把首页误扫记录放进下拉框。
    if (!chat || chat.length < 10 || /^(home|chat|conversation|legacy)$/i.test(chat)) continue;
    const title = conversationTitle(item);
    if (!groups.has(id)) {
      groups.set(id, { title, chat, titleVotes: new Map(), count: 0, latest: 0 });
    }
    const group = groups.get(id);
    group.count += 1;
    group.latest = Math.max(group.latest, item.record.captured_at || 0);
    group.titleVotes.set(title, (group.titleVotes.get(title) || 0) + 1);
  }
  const preferredId = preferCurrent ? resolvePreferredConversationId(groups) : null;
  if (preferredId && !groups.has(preferredId) && activeConversationId && activeChatId().length >= 10) {
    groups.set(preferredId, {
      title: activeConversationTitle || "当前会话",
      chat: activeChatId(),
      titleVotes: new Map([[activeConversationTitle || "当前会话", 1]]),
      count: 0,
      latest: Number.MAX_SAFE_INTEGER
    });
  } else if (preferCurrent && activeConversationId && activeChatId().length >= 10 && !groups.has(activeConversationId) && !preferredId) {
    groups.set(activeConversationId, {
      title: activeConversationTitle || "当前会话",
      chat: activeChatId(),
      titleVotes: new Map([[activeConversationTitle || "当前会话", 1]]),
      count: 0,
      latest: Number.MAX_SAFE_INTEGER
    });
  }
  elements.conversationFilter.replaceChildren(new Option("全部会话", "all"));
  for (const [id, group] of Array.from(groups.entries()).sort((a, b) => b[1].latest - a[1].latest)) {
    elements.conversationFilter.add(new Option(pickGroupTitle(group), id));
  }
  const preferred = preferCurrent
    ? (preferredId || (groups.has(activeConversationId) ? activeConversationId : null))
    : null;
  const target = preferred || previous;
  elements.conversationFilter.value = ["all", ...groups.keys()].includes(target) ? target : (preferred || "all");
}

function render() {
  const currentRender = ++renderVersion;
  elements.loading.hidden = true;
  elements.gallery.replaceChildren();
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
  const visible = visibleMedia();
  elements.count.textContent = `共 ${visible.length}`;
  elements.empty.hidden = visible.length !== 0;
  elements.toolbar.hidden = visible.length === 0;
  elements.clearAll.disabled = media.length === 0;

  const showSectionTitles = elements.conversationFilter.value === "all";
  const groups = new Map();
  for (const item of visible) {
    const id = conversationId(item);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(item);
  }
  const pendingCards = [];
  for (const items of groups.values()) {
    const section = document.createElement("section");
    section.className = "conversation-section";
    if (showSectionTitles) {
      const title = document.createElement("div");
      title.className = "section-title";
      title.innerHTML = `<strong></strong><span>${items.length} 项</span>`;
      title.querySelector("strong").textContent = conversationTitle(items[0]);
      section.appendChild(title);
    }
    const grid = document.createElement("div");
    grid.className = "media-grid";
    items.forEach((item) => pendingCards.push({ item, grid }));
    section.appendChild(grid);
    elements.gallery.appendChild(section);
  }
  updateSelection();

  let cursor = 0;
  const appendBatch = () => {
    if (currentRender !== renderVersion) return;
    const end = Math.min(cursor + 12, pendingCards.length);
    while (cursor < end) {
      const { item, grid } = pendingCards[cursor++];
      grid.appendChild(item.type === "image" ? createImageItem(item) : createVideoItem(item));
    }
    if (cursor < pendingCards.length) requestAnimationFrame(appendBatch);
    else updateSelection();
  };
  if (pendingCards.length) requestAnimationFrame(appendBatch);
}

function createBaseItem(item, alt) {
  const card = document.createElement("article");
  card.className = `item ${item.type}`;
  card.dataset.key = item.key;
  const wrap = document.createElement("div");
  wrap.className = "thumb-wrap";
  const thumbnail = document.createElement("img");
  thumbnail.className = "thumb";
  thumbnail.alt = alt;
  thumbnail.loading = "lazy";
  thumbnail.decoding = "async";
  if (item.record.thumbnail_blob instanceof Blob) {
    const url = URL.createObjectURL(item.record.thumbnail_blob);
    objectUrls.add(url);
    thumbnail.src = url;
  } else if (item.record.poster_url) thumbnail.src = item.record.poster_url;
  wrap.appendChild(thumbnail);
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "check";
  checkbox.checked = selected.has(item.key);
  checkbox.setAttribute("aria-label", `选择${item.type === "image" ? "图片" : "视频"}`);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) selected.add(item.key); else selected.delete(item.key);
    updateSelection();
  });
  card.classList.toggle("selected", selected.has(item.key));
  return { card, wrap, checkbox };
}

function appendMetaAndActions(card, metaText, record, checkbox, actionButtons) {
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = metaText;
  const time = document.createElement("div");
  time.className = "time";
  time.textContent = record.captured_at
    ? new Date(record.captured_at).toLocaleString("zh-CN", { hour12: false })
    : "历史记录";
  const actions = document.createElement("div");
  actions.className = "actions";
  const selectAction = document.createElement("label");
  selectAction.className = "select-action";
  selectAction.appendChild(checkbox);
  actions.append(selectAction, ...actionButtons);
  card.append(meta, time, actions);
}

const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v10m0 0 4-4m-4 4-4-4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 12a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l1-12M10 11v6m4-6v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function createImageItem(item) {
  const image = item.record;
  const { card, wrap, checkbox } = createBaseItem(item, "豆包生成图片缩略图");
  card.appendChild(wrap);
  const download = iconButton("download", "下载", ICON_DOWNLOAD, async (button) => {
    setBusy(button);
    const response = await sendMessage({ type: "DOWNLOAD_IMAGE", image: toImageDownloadRecord(image) });
    resetIconButton(button, ICON_DOWNLOAD);
    showNotice(response?.ok === false ? `图片下载失败：${response.error}` : "图片下载已提交", response?.ok === false);
  });
  const remove = iconButton("delete", "删除这条历史记录", ICON_TRASH, async (button) => {
    button.disabled = true;
    const response = await sendMessage({ type: "DELETE_IMAGE", image_id: image.image_id });
    await afterDelete(response, item.key, "图片");
  });
  appendMetaAndActions(
    card,
    `${image.width || "?"} × ${image.height || "?"} · ${(image.extension || "jpg").toUpperCase()}`,
    image,
    checkbox,
    [download, remove]
  );
  return card;
}

function createVideoItem(item) {
  const video = item.record;
  const { card, wrap, checkbox } = createBaseItem(item, "豆包生成视频封面");
  const kind = document.createElement("span");
  kind.className = "kind-badge";
  kind.textContent = "视频";
  const play = document.createElement("span");
  play.className = "play-badge";
  play.textContent = "▶";
  wrap.append(kind, play);
  card.appendChild(wrap);
  const download = iconButton("download", "下载", ICON_DOWNLOAD, async (button) => {
    setBusy(button);
    const response = await sendMessage({ type: "DOWNLOAD_VIDEO", video });
    resetIconButton(button, ICON_DOWNLOAD);
    showNotice(response?.ok === false ? `视频下载失败：${response.error}` : "视频已加入下载队列", response?.ok === false);
  });
  const remove = iconButton("delete", "删除这条历史记录", ICON_TRASH, async (button) => {
    button.disabled = true;
    const response = await sendMessage({ type: "DELETE_VIDEO", video_record_id: video.video_record_id });
    await afterDelete(response, item.key, "视频");
  });
  appendMetaAndActions(
    card,
    `${video.width || "?"} × ${video.height || "?"} · ${(video.format || "mp4").toUpperCase()}`,
    video,
    checkbox,
    [download, remove]
  );
  return card;
}

function iconButton(className, title, svg, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-action ${className}`;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = svg;
  button.addEventListener("click", () => handler(button));
  return button;
}

function setBusy(button) {
  button.disabled = true;
  button.classList.add("busy");
}

function resetIconButton(button, svg) {
  button.disabled = false;
  button.classList.remove("busy");
  button.innerHTML = svg;
}

function setBusyText(button, label) { button.disabled = true; button.textContent = label; }
function resetButton(button, label) { button.disabled = false; button.textContent = label; }

async function afterDelete(response, key, kind) {
  if (response?.ok === false) showNotice(`删除失败：${response.error}`, true);
  else {
    selected.delete(key);
    await loadMedia({ silent: true });
    showNotice(`已删除${kind}记录`);
  }
}

function toImageDownloadRecord(image) {
  return {
    image_id: image.image_id,
    image_ori_raw_url: image.image_ori_raw_url || image.raw_url,
    image_ori_url: image.image_ori_url,
    image_preview_url: image.image_preview_url,
    image_thumb_url: image.image_thumb_url,
    captured_at: image.captured_at,
    conversation_id: image.conversation_id || "legacy",
    conversation_chat_id: image.conversation_chat_id || "",
    conversation_title: image.conversation_title || "",
    page_url: image.page_url
  };
}

function updateSelection() {
  const visible = visibleMedia();
  const allKeys = new Set(media.map((item) => item.key));
  const visibleKeys = new Set(visible.map((item) => item.key));
  selected.forEach((key) => { if (!allKeys.has(key)) selected.delete(key); });
  elements.gallery.querySelectorAll(".check").forEach((checkbox) => {
    const card = checkbox.closest(".item");
    checkbox.checked = selected.has(card.dataset.key);
    card.classList.toggle("selected", checkbox.checked);
  });
  const count = Array.from(selected).filter((key) => visibleKeys.has(key)).length;
  elements.selectedCount.textContent = `已选 ${count}`;
  elements.batchDownload.disabled = count === 0;
  elements.selectAll.checked = visible.length > 0 && count === visible.length;
  elements.selectAll.indeterminate = count > 0 && count < visible.length;
}

async function clearAllMediaCache() {
  if (!confirm("确定清空全部本地图片和视频记录吗？")) {
    return false;
  }
  const imageResponse = await sendMessage({ type: "CLEAR_IMAGES" });
  const videoResponse = await sendMessage({ type: "CLEAR_VIDEOS" });
  if (imageResponse?.ok === false || videoResponse?.ok === false) {
    showNotice(`清空失败：${imageResponse?.error || videoResponse?.error}`, true);
    return false;
  }
  selected.clear();
  await loadMedia({ silent: true, keepFilter: false, preferCurrent: true });
  showNotice("已清空全部记录");
  return true;
}

async function copyWechatId() {
  try {
    await navigator.clipboard.writeText(WECHAT_ID);
    showNotice(`微信号已复制：${WECHAT_ID}`);
  } catch (_) {
    showNotice(`请手动复制微信号：${WECHAT_ID}`, true);
  }
}

elements.conversationFilter.addEventListener("change", () => { selected.clear(); render(); });
elements.mediaTabs.addEventListener("click", (event) => {
  const button = event.target.closest(".media-tab");
  if (!button) return;
  selected.clear();
  setMediaKind(button.dataset.kind);
  render();
});

elements.selectAll.addEventListener("change", () => {
  const visible = visibleMedia();
  if (elements.selectAll.checked) visible.forEach((item) => selected.add(item.key));
  else visible.forEach((item) => selected.delete(item.key));
  updateSelection();
});

elements.batchDownload.addEventListener("click", async () => {
  const visibleKeys = new Set(visibleMedia().map((item) => item.key));
  const chosen = media.filter((item) => visibleKeys.has(item.key) && selected.has(item.key));
  const images = chosen.filter((item) => item.type === "image").map((item) => toImageDownloadRecord(item.record));
  const videos = chosen.filter((item) => item.type === "video").map((item) => item.record);
  if (!chosen.length) return;
  setBusyText(elements.batchDownload, `提交 ${chosen.length} 项…`);
  const imageResponse = images.length ? await sendMessage({ type: "BATCH_DOWNLOAD", images }) : { ok: true, success: 0 };
  const videoResponse = videos.length ? await sendMessage({ type: "BATCH_VIDEO_DOWNLOAD", videos }) : { ok: true, queued: 0 };
  resetButton(elements.batchDownload, "批量下载");
  updateSelection();
  const failed = imageResponse?.ok === false || videoResponse?.ok === false;
  showNotice(
    failed
      ? `部分任务提交失败：${imageResponse?.error || videoResponse?.error || "未知错误"}`
      : `已提交图片 ${imageResponse.success || 0} 张、视频 ${videoResponse.queued || 0} 个`,
    failed
  );
});

elements.clearAll.addEventListener("click", () => { clearAllMediaCache(); });

elements.reconnectVideo.addEventListener("click", async () => {
  setBusyText(elements.reconnectVideo, "…");
  const response = await sendMessage({ type: "RECONNECT_VIDEO" });
  resetButton(elements.reconnectVideo, "重连");
  await loadCaptureStatus();
  if (response?.ok === false) showNotice(`连接失败：${response.error}`, true);
});

elements.contactBtn.addEventListener("click", copyWechatId);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "GALLERY_UPDATED") {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => loadMedia({ silent: true }), 250);
  }
  if (message?.type === "DOWNLOAD_RETRYING" || message?.type === "VIDEO_DOWNLOAD_RETRYING") {
    showNotice(`下载异常，正在自动重试（${message.attempt}/${message.max_attempts}）…`);
  }
  if (message?.type === "DOWNLOAD_COMPLETE" || message?.type === "VIDEO_DOWNLOAD_COMPLETE") {
    showNotice(`下载完成${message.attempts > 1 ? `（尝试 ${message.attempts} 次）` : ""}`);
  }
  if (message?.type === "DOWNLOAD_FAILED" || message?.type === "VIDEO_DOWNLOAD_FAILED") {
    showNotice(`下载最终失败：${message.error || "未知错误"}`, true, 6000);
  }
});

window.addEventListener("unload", () => { for (const url of objectUrls) URL.revokeObjectURL(url); });

async function initialize() {
  setMediaKind("all");
  // 确保总开关为开启（已移除 Popup 开关 UI）。
  await sendMessage({ type: "SET_EXTENSION_ENABLED", enabled: true });
  await loadCaptureMode();
  await loadCaptureStatus();
  await loadMedia({ keepFilter: false, preferCurrent: true });
}

initialize();
