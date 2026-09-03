# 豆包无水印图片和视频一键下载

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-2.5.0-blue.svg)](./CHANGELOG.md)
[![GitHub stars](https://img.shields.io/github/stars/XiaoYu43002/DoubaoWaterMark-Remover)](https://github.com/XiaoYu43002/DoubaoWaterMark-Remover/stargazers)

在豆包对话页一键获取无水印原图与高清无水印视频的工具/浏览器插件。支持一键下载

> [!NOTE]
> 时效：2026.9.3 测试有效
>
> 后期随时可能失效。如果不是因为原理破坏而失效，可以提 PR / Issue，我们会跟进适配。
>
> _**安装 👉 [Chrome 扩展（图+视频）](#方式一chrome-扩展完整功能图片--视频) | [油猴脚本（图片）](https://github.com/XiaoYu43002/DoubaoWaterMark-Remover/raw/main/userscript/doubao-nomark-images.user.js)**_

---

## 快速开始

### 方式一：Chrome 扩展（完整功能：图片 + 视频）

1. 打开本仓库，点击 **Code → Download ZIP**，或 `git clone` 后解压到固定目录  
2. 打开 Chrome → `chrome://extensions/` → 开启 **开发者模式**  
3. 点击 **「加载已解压的扩展程序」**，选择仓库里的 **`doubaoparser`** 文件夹  
4. 确认名称为 `豆包图片视频去水印`（DoubaoWaterMark-Remover）、版本 `2.5.0`  
5. 打开 [豆包](https://www.doubao.com)，按 `Ctrl + Shift + R` 强制刷新  

若曾安装其它占用 Debugger 的豆包视频类扩展，请先禁用。更细的回归与排错见 [docs/testing.md](./docs/testing.md)。

（上架 Chrome 网上应用店后，将在此补充一键安装链接。）

### 方式二：油猴脚本 / Greasy Fork（目前仅图片）

视频无水印依赖 Chrome 的 `debugger` API，**油猴环境无法完整提供**，因此脚本版以无水印图片为主。完整图+视频请用上方 Chrome 扩展。

**快速安装：**

1. 先安装 [Tampermonkey](https://www.tampermonkey.net/)（或其它油猴管理器）  
2. 打开脚本文件安装：  
   [doubao-nomark-images.user.js](https://github.com/XiaoYu43002/DoubaoWaterMark-Remover/raw/main/userscript/doubao-nomark-images.user.js)  
3. 在 Tampermonkey 中确认启用，打开豆包对话页并刷新  

发布到 [Greasy Fork](https://greasyfork.org/) 后，可将上面的链接替换为 Greasy Fork 一键安装页。

---

## 功能特性

### 🎛️ 就绪提示

- 进入豆包页后，屏幕**正中央**短暂显示：**插件已就绪 · 数据仅在本地处理**
- 页内面板底部：左侧 **支持作者**，右侧 **全部下载**（不再显示「图片 N 张」数量文案）

### 🖼️ 无水印图片

- ⚡ **对话页无水印原图**：豆包对话页面新生成的图片直接展示的是无水印图片可直接利用豆包原始下载按钮
- 🖱️ **会话内图片 + 右侧大图**：浏览与预览链路均展示无水印图片
- 💾 **豆包原生下载增强**：页面原生下载尽量走无水印原图链路
- 📦 本机仅缓存缩略图与元数据，不保存原始大文件

### 🎬 无水印高清视频

- 🚀 **高清原始无水印视频**：通过对豆包接口进行解密获取原始水印视频下载地址
- 🔄 预览前自动刷新临时地址；下载失败自动重试，并尽量选择最高画质
- ⚠️ 页顶出现「正在调试此浏览器」为视频监听的**预期现象**，请勿点「取消」

### 📋 媒体管理（页内面板 + Popup）

- 🎛️ **页内蓝色面板**：打开豆包会话即可出现，图片 / 视频分 Tab，单项或全部下载
- 🗂️ **Popup 历史库**：按「会话标题 - Chat ID」分类，筛选全部媒体 / 图片 / 视频
- ✅ 勾选批量下载；支持图片 + 视频混合队列
- 🧭 捕获模式：「仅当前会话」或「记录所有打开会话」
- 🧹 缓存上限 50 / 100 / 250 / 500 MB，可一键整理最旧记录

### 📚 历史对话素材

- 打开或刷新过的会话，图片与视频会进入本机历史
- 支持按会话筛选后批量下载高质量无水印图片 / 视频
- 说明：不会在后台扫描账号里「从未打开过」的全部历史；重新打开旧会话后即可捕获

---

## 界面演示

> 可将截图放入 `docs/images/` 后取消下面注释或替换路径。

```text
页内媒体面板 · Popup 历史库 · 图片/视频下载效果
（截图待补充：docs/images/panel.png、popup.png、download-demo.png）
```

<!-- 有截图后改为：
![页内面板](docs/images/panel.png)
![Popup](docs/images/popup.png)
![下载效果](docs/images/download-demo.png)
-->

---

## 特别说明

### 会话范围

1. 当前打开的会话  
2. 安装后新建并打开的会话  
3. 安装前的旧会话——重新打开或刷新后再捕获  

「全部会话」= 插件本机已捕获的会话，不是豆包服务器全量历史。

### 视频原理（简要）

扩展使用 `chrome.debugger` 监听豆包相关响应，解析无水印视频地址并下载。同一标签页通常只能被一个 Debugger 客户端占用，请禁用其它同类视频调试扩展。

### 与同类方案

生态中另有油猴脚本、API / Edge 等实现，侧重点不同。本仓库定位为 **Chrome MV3：图片 + 视频同一套 UI + 本地历史**。可对照：

- [Qalxry/doubao-no-watermark](https://github.com/Qalxry/doubao-no-watermark)（油猴 · 图片等）
- [ihmily/doubao-nomark](https://github.com/ihmily/doubao-nomark)（API / Edge / 油猴）

---

## 使用方法

### 图片

1. 打开含生成图片的豆包会话并刷新  
2. 确认会话内图、右侧大图为无水印；可用页内面板或 Popup 下载  
3. 豆包原生下载按钮也应尽量得到无水印原图  

### 视频

1. 打开含生成视频的会话并强制刷新  
2. Popup 中视频状态为绿色「视频监听已连接」  
3. 使用预览 / 下载；下载来源一般为字节相关视频域名  

### 历史与批量

1. 在多个会话中捕获媒体后打开 Popup  
2. 按会话与类型筛选，勾选后批量下载  
3. 需要时调整缓存上限并「立即整理」  

---

## 目录结构

```text
DoubaoWaterMark-Remover/
├── README.md
├── CHANGELOG.md
├── LICENSE
├── docs/testing.md
├── doubaoparser/       # Chrome「加载已解压的扩展程序」选此目录
│   ├── opaque/
│   │   └── xcodec.wasm # 运行时还原材料（Wasm）
│   └── opaque-material.js
└── userscript/
    └── doubao-nomark-images.user.js   # 油猴 / Greasy Fork（图片）
```

---

## 权限与隐私

| 权限 | 用途 |
|------|------|
| `debugger` | 解析无水印视频地址 |
| `downloads` | 本机下载 |
| `storage` | 偏好设置 |
| `tabs` | 会话识别 |
| 主机权限 | 豆包 / 字节相关媒体域 |

数据仅存本机 IndexedDB，不上传聊天内容到开发者服务器。

---

## 更新日志

见 [CHANGELOG.md](./CHANGELOG.md)。

---

## 开发与反馈

- 品牌：**十一木**  
- 仓库：https://github.com/XiaoYu43002/DoubaoWaterMark-Remover  
- Popup 内可复制微信号反馈  
- 欢迎 Issue / PR  

## 特别鸣谢

感谢豆包无水印相关开源生态的先行者与贡献者（实现路径不同，可对照学习）：

- [Qalxry/doubao-no-watermark](https://github.com/Qalxry/doubao-no-watermark)
- [ihmily/doubao-nomark](https://github.com/ihmily/doubao-nomark)

## 许可证

[MIT License](./LICENSE)

## Star History

[![Star History Chart](https://star-history.dera.page/svg?repos=XiaoYu43002/DoubaoWaterMark-Remover&type=date&legend=top-left)](https://star-history.dera.page/#XiaoYu43002/DoubaoWaterMark-Remover&type=Date&legend=top-left)

---

⚠️ **免责声明**: 本扩展仅供学习交流使用，请遵守相关网站的使用条款。

**注意**：使用本服务时请遵守豆包平台的使用条款和相关法律法规
