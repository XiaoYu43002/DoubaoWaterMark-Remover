"use strict";

const DB_NAME = "DoubaoDB";
const DB_VERSION = 4;
const STORE_NAME = "images_v2";
const VIDEO_STORE_NAME = "videos_v1";

function ensureIndex(store, name, keyPath, options = {}) {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      const store = db.objectStoreNames.contains(STORE_NAME)
        ? event.target.transaction.objectStore(STORE_NAME)
        : db.createObjectStore(STORE_NAME, { keyPath: "image_id" });

      ensureIndex(store, "raw_url", "raw_url", { unique: true });
      ensureIndex(store, "captured_at", "captured_at", { unique: false });
      ensureIndex(store, "conversation_id", "conversation_id", { unique: false });
      ensureIndex(store, "updated_at", "updated_at", { unique: false });

      const videoStore = db.objectStoreNames.contains(VIDEO_STORE_NAME)
        ? event.target.transaction.objectStore(VIDEO_STORE_NAME)
        : db.createObjectStore(VIDEO_STORE_NAME, { keyPath: "video_record_id" });
      ensureIndex(videoStore, "video_id", "video_id", { unique: false });
      ensureIndex(videoStore, "conversation_id", "conversation_id", { unique: false });
      ensureIndex(videoStore, "captured_at", "captured_at", { unique: false });
      ensureIndex(videoStore, "updated_at", "updated_at", { unique: false });
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("数据库升级被其他扩展页面阻塞，请关闭旧 Popup 后重试"));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function completeTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error("IndexedDB 操作失败"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB 操作被中止"));
  });
}

async function saveImage(data) {
  const db = await openDB();
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(data);
    await completeTransaction(tx);
    return data;
  } finally {
    db.close();
  }
}

async function getImage(imageId) {
  const db = await openDB();
  try {
    const tx = db.transaction(STORE_NAME, "readonly");
    return await requestResult(tx.objectStore(STORE_NAME).get(imageId));
  } finally {
    db.close();
  }
}

async function getImageByRawUrl(rawUrl) {
  const db = await openDB();
  try {
    const tx = db.transaction(STORE_NAME, "readonly");
    return await requestResult(tx.objectStore(STORE_NAME).index("raw_url").get(rawUrl));
  } finally {
    db.close();
  }
}

async function getAllImages() {
  const db = await openDB();
  try {
    const tx = db.transaction(STORE_NAME, "readonly");
    return await requestResult(tx.objectStore(STORE_NAME).getAll());
  } finally {
    db.close();
  }
}

function isPlausibleStoredImage(record) {
  if (!record) return false;
  if (!(record.image_ori_raw_url || record.raw_url)) return false;
  const chatId = String(record.conversation_chat_id || "").trim() ||
    String(record.conversation_id || "").split(":").pop() || "";
  if (!chatId || chatId.length < 10 ||
      /^(home|chat|conversation|new|index|explore|discover|bot|agent|legacy)$/i.test(chatId)) {
    return false;
  }
  const title = String(record.conversation_title || "");
  if (/字节跳动旗下|智能助手|未进入会话/i.test(title)) return false;
  const width = Number(record.width) || 0;
  const height = Number(record.height) || 0;
  if (!width || !height) return true;
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  return shortSide >= 256 && longSide / shortSide <= 2.6;
}

async function pruneImplausibleImages() {
  const images = await getAllImages();
  const victims = images.filter((image) => !isPlausibleStoredImage(image));
  if (!victims.length) return 0;
  const db = await openDB();
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const image of victims) store.delete(image.image_id);
    await completeTransaction(tx);
    return victims.length;
  } finally {
    db.close();
  }
}

async function deleteImage(imageId) {
  const db = await openDB();
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(imageId);
    await completeTransaction(tx);
  } finally {
    db.close();
  }
}

async function deleteImagesByConversation(conversationId) {
  const db = await openDB();
  let deleted = 0;
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const request = tx.objectStore(STORE_NAME).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const recordConversationId = cursor.value.conversation_id || "legacy";
      if (recordConversationId === conversationId) {
        cursor.delete();
        deleted += 1;
      }
      cursor.continue();
    };
    await completeTransaction(tx);
    return deleted;
  } finally {
    db.close();
  }
}

async function clearImages() {
  const db = await openDB();
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    await completeTransaction(tx);
  } finally {
    db.close();
  }
}

async function saveVideo(data) {
  const db = await openDB();
  try {
    const tx = db.transaction(VIDEO_STORE_NAME, "readwrite");
    tx.objectStore(VIDEO_STORE_NAME).put(data);
    await completeTransaction(tx);
    return data;
  } finally {
    db.close();
  }
}

async function getVideo(videoRecordId) {
  const db = await openDB();
  try {
    const tx = db.transaction(VIDEO_STORE_NAME, "readonly");
    return await requestResult(tx.objectStore(VIDEO_STORE_NAME).get(videoRecordId));
  } finally {
    db.close();
  }
}

async function getAllVideos() {
  const db = await openDB();
  try {
    const tx = db.transaction(VIDEO_STORE_NAME, "readonly");
    return await requestResult(tx.objectStore(VIDEO_STORE_NAME).getAll());
  } finally {
    db.close();
  }
}

async function deleteVideo(videoRecordId) {
  const db = await openDB();
  try {
    const tx = db.transaction(VIDEO_STORE_NAME, "readwrite");
    tx.objectStore(VIDEO_STORE_NAME).delete(videoRecordId);
    await completeTransaction(tx);
  } finally {
    db.close();
  }
}

async function deleteVideosByConversation(conversationId) {
  const db = await openDB();
  let deleted = 0;
  try {
    const tx = db.transaction(VIDEO_STORE_NAME, "readwrite");
    const request = tx.objectStore(VIDEO_STORE_NAME).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if ((cursor.value.conversation_id || "legacy") === conversationId) {
        cursor.delete();
        deleted += 1;
      }
      cursor.continue();
    };
    await completeTransaction(tx);
    return deleted;
  } finally {
    db.close();
  }
}

async function clearVideos() {
  const db = await openDB();
  try {
    const tx = db.transaction(VIDEO_STORE_NAME, "readwrite");
    tx.objectStore(VIDEO_STORE_NAME).clear();
    await completeTransaction(tx);
  } finally {
    db.close();
  }
}

function estimateRecordBytes(record) {
  const thumbnailBytes = record.thumbnail_blob instanceof Blob ? record.thumbnail_blob.size : 0;
  const textBytes = [
    record.image_id,
    record.raw_url,
    record.image_ori_raw_url,
    record.image_ori_url,
    record.image_preview_url,
    record.image_thumb_url,
    record.conversation_id,
    record.conversation_chat_id,
    record.conversation_title,
    record.page_url
  ].reduce((total, value) => total + String(value || "").length * 2, 0);
  return thumbnailBytes + textBytes + 512;
}

function estimateVideoRecordBytes(record) {
  const thumbnailBytes = record.thumbnail_blob instanceof Blob ? record.thumbnail_blob.size : 0;
  const textBytes = [
    record.video_record_id,
    record.video_id,
    record.fallback_api,
    record.url,
    record.poster_url,
    record.message_id,
    record.conversation_id,
    record.conversation_chat_id,
    record.conversation_title,
    record.page_url,
    record.format,
    record.definition
  ].reduce((total, value) => total + String(value || "").length * 2, 0);
  return thumbnailBytes + textBytes + 768;
}

async function getCacheStats() {
  const [images, videos] = await Promise.all([getAllImages(), getAllVideos()]);
  const bytes = images.reduce((total, image) => total + estimateRecordBytes(image), 0) +
    videos.reduce((total, video) => total + estimateVideoRecordBytes(video), 0);
  const conversations = new Set([
    ...images.map((image) => image.conversation_id || "legacy"),
    ...videos.map((video) => video.conversation_id || "legacy")
  ]);
  return {
    bytes,
    count: images.length + videos.length,
    image_count: images.length,
    video_count: videos.length,
    conversations: conversations.size
  };
}

function isGenericConversationTitle(title) {
  const text = String(title || "").trim();
  if (!text) return true;
  if (/^(未分类历史|未命名会话|未进入会话|当前会话)$/.test(text)) return true;
  if (/^对话\s+\S+$/.test(text)) return true;
  if (/智能助手|字节跳动旗下/.test(text)) return true;
  return false;
}

function pickConversationTitle(existingTitle, nextTitle) {
  const existing = String(existingTitle || "").trim();
  const next = String(nextTitle || "").trim();
  if (!next || isGenericConversationTitle(next)) return existing || "未分类历史";
  if (!existing || isGenericConversationTitle(existing)) return next;
  // 已有正常标题时不要被 SPA 切换瞬间的旧标题覆盖。
  return existing;
}

function recordMatchesConversation(record, conversationId, chatId) {
  const rid = String(record?.conversation_id || "").trim();
  const rchat = String(record?.conversation_chat_id || "").trim();
  if (conversationId && rid && rid === conversationId) return true;
  if (chatId && rchat && rchat === chatId) return true;
  if (chatId && rid && (rid.endsWith(`:${chatId}`) || rid === chatId)) return true;
  return false;
}

async function updateConversationTitles({ conversation_id, conversation_chat_id, conversation_title }) {
  const title = String(conversation_title || "").trim().slice(0, 120);
  if (!title || isGenericConversationTitle(title)) return { updated: 0 };
  const conversationId = String(conversation_id || "").trim();
  const chatId = String(conversation_chat_id || "").trim();
  if (!conversationId && !chatId) return { updated: 0 };

  let updated = 0;
  const db = await openDB();
  try {
    const tx = db.transaction([STORE_NAME, VIDEO_STORE_NAME], "readwrite");
    const imageStore = tx.objectStore(STORE_NAME);
    const videoStore = tx.objectStore(VIDEO_STORE_NAME);

    const walk = (store) => new Promise((resolve, reject) => {
      const request = store.openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve();
        const value = cursor.value;
        if (recordMatchesConversation(value, conversationId, chatId) && value.conversation_title !== title) {
          cursor.update({ ...value, conversation_title: title, updated_at: Date.now() });
          updated += 1;
        }
        cursor.continue();
      };
    });

    await Promise.all([walk(imageStore), walk(videoStore)]);
    await completeTransaction(tx);
  } finally {
    db.close();
  }
  return { updated };
}

async function pruneCache(maxBytes, maxItems) {
  const [images, videos] = await Promise.all([getAllImages(), getAllVideos()]);
  const records = [
    ...images.map((record) => ({
      type: "image",
      id: record.image_id,
      bytes: estimateRecordBytes(record),
      time: record.updated_at || record.captured_at || 0
    })),
    ...videos.map((record) => ({
      type: "video",
      id: record.video_record_id,
      bytes: estimateVideoRecordBytes(record),
      time: record.updated_at || record.captured_at || 0
    }))
  ].sort((a, b) => a.time - b.time);
  let bytes = records.reduce((total, record) => total + record.bytes, 0);
  let count = records.length;
  let deleted = 0;

  for (const record of records) {
    if (bytes <= maxBytes && count <= maxItems) break;
    if (record.type === "image") await deleteImage(record.id);
    else await deleteVideo(record.id);
    bytes -= record.bytes;
    count -= 1;
    deleted += 1;
  }

  return { bytes: Math.max(0, bytes), count, deleted };
}
