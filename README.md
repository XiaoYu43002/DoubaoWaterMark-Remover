# DoubaoWaterMark-Remover

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Chrome](https://img.shields.io/badge/Chrome-MV3-green.svg)](./extension/manifest.json)
[![Version](https://img.shields.io/badge/version-2.3.2-blue.svg)](./CHANGELOG.md)

**十一木** 出品 · 豆包对话页 **图片 / 视频无水印原媒** 下载与管理（Chrome Manifest V3 扩展）

在豆包（[doubao.com](https://www.doubao.com)）会话中捕获已生成的图片与视频，优先使用无水印原始地址，支持页内面板与 Popup 历史管理、按会话分类、批量下载与本地缓存控制。

> 时效说明：依赖豆包页面与接口实现，平台改版后可能失效。欢迎提 Issue / PR。

---

## 功能特性

### 图片

- 会话内图片、右侧大图、豆包原生下载链路尽量走无水印原图
- DOM / React Fiber 识别 + 页面脚本配合提取原图字段
- 仅保存缩略图与元数据到本机 IndexedDB，不存原始大文件

### 视频

- 使用 `chrome.debugger` 监听相关链路响应，解析无水印 / 高画质地址
- Popup 显示监听状态；支持重连、预览（刷新临时链）、下载失败自动重试
- 页面顶部出现「正在调试此浏览器」属于预期行为，请勿点「取消」

### 管理与体验

- **页内面板**：豆包页右上方自动出现，仅展示**本次页面加载后**识别到的图片 / 视频
- **Popup**：完整历史；按「会话标题 - Chat ID」分类；筛选全部 / 图片 / 视频
- 单项与批量下载、删除单条 / 删除分类 / 清空全部
- 捕获模式：「仅当前会话」或「记录所有打开会话」
- 图片 + 视频共用缓存上限（50 / 100 / 250 / 500 MB），可一键整理

### 会话范围（重要）

插件**不会**拉取豆包账号下全部历史对话。可覆盖：

1. 当前打开的会话  
2. 安装后新建并打开的会话  
3. 安装前的旧会话——需重新打开或刷新后再捕获  

「全部会话」= 本机已捕获过的会话，不是服务端全量历史。

---

## 目录结构

```text
DoubaoWaterMark-Remover/
├── README.md
├── CHANGELOG.md
├── LICENSE
├── .gitignore
├── docs/
│   └── testing.md          # 详细测试与排错说明
└── extension/              # ← Chrome「加载已解压的扩展程序」选这个目录
    ├── manifest.json
    ├── background.js
    ├── content.js
    ├── injected.js
    ├── video.js
    ├── db.js
    ├── popup.html / popup.js / popup.css
    └── contact-icon.png
```

---

## 安装方法

### 方式一：从本仓库加载（开发 / 自用）

1. Clone 或下载 ZIP 并解压到固定目录  
2. 打开 Chrome → `chrome://extensions/` → 打开**开发者模式**  
3. 点击 **「加载已解压的扩展程序」**，选择本仓库中的 **`extension`** 文件夹  
4. 确认扩展名为 `Doubao Original Media Helper`，版本为 `2.3.2`  
5. 打开豆包页面，按 `Ctrl + Shift + R` 强制刷新  

若曾安装其它占用 Debugger 的豆包视频类扩展，请先禁用，避免冲突。

### 方式二：Chrome 网上应用店

（上架后在此补充商店链接）

---

## 使用方法

1. 打开 [豆包](https://www.doubao.com) 任意含生成图片 / 视频的会话并刷新  
2. 页面右上方出现蓝色媒体面板：可切换图片 / 视频、单项或全部下载  
3. 点击扩展图标打开 Popup：查看历史、筛选会话、批量下载、管理缓存  
4. 视频功能需保持 Debugger 连接（页顶调试提示为正常现象）  

更多回归步骤与 FAQ 见 [docs/testing.md](./docs/testing.md)。

---

## 权限说明

| 权限 | 用途 |
|------|------|
| `debugger` | 监听豆包相关响应以解析无水印视频地址 |
| `downloads` | 触发本机文件下载 |
| `storage` | 保存捕获模式等偏好 |
| `tabs` | 识别当前会话标签与标题 |
| 主机权限 | 访问豆包 / 字节相关媒体域名 |

**隐私：** 媒体链接、缩略图与会话标识仅存本机；不上传聊天内容到开发者服务器。排错时请勿公开 Cookie、Token、完整私人对话或临时媒体 URL。

---

## 与同类项目的关系

生态中已有优秀开源实现，实现路径不同，可按需求选用或参考：

| 项目 | 形态 | 侧重 |
|------|------|------|
| [Qalxry/doubao-no-watermark](https://github.com/Qalxry/doubao-no-watermark) | 油猴脚本 | 图片无水印（含编辑后图）、提示词库等 |
| [ihmily/doubao-nomark](https://github.com/ihmily/doubao-nomark) | API + Edge / 油猴 | 分享链接解析、服务端 / 插件多端 |

本仓库定位为 **Chrome MV3 扩展**：图片 + 视频同一套 UI，本地历史与缓存，视频侧使用 Debugger 抓取链路。若你的实现参考了上述或其它开源项目，请遵守其许可证并保留致谢。

---

## 更新日志

见 [CHANGELOG.md](./CHANGELOG.md)。

---

## 开发与反馈

- 品牌：**十一木**  
- GitHub：[@XiaoYu43002](https://github.com/XiaoYu43002)  
- 扩展内 Popup 提供联系反馈入口（复制微信号）  
- 欢迎 Issue / PR：失效适配、体验优化、文档补全  

---

## 许可证

[MIT License](./LICENSE) © 十一木

---

## 免责声明

本工具仅供学习交流与用户保存**本人有权使用**的素材。请遵守豆包平台服务条款及当地法律法规。因平台接口变更导致的功能失效，或因不当使用产生的纠纷，作者不承担责任。
