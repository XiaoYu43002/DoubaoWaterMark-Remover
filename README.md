# 豆包无水印图片和视频一键下载

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-2.5.2-blue.svg)](./CHANGELOG.md)
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
4. 确认名称为 `豆包图片视频去水印`（DoubaoWaterMark-Remover）、版本 `2.5.2`  
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

### 1. 已有会话：水印与解析

打开旧会话时，对话里仍可能看到「豆包AI生成」等水印；右侧页内面板会解析出对应资源，并标注为**无水印**，可单独下载。

![已有会话水印与解析](https://s1.mnat.cn/2026/09/03/6a9941882eb53.png)

- 🔖 **水印对照**：会话内媒体角标仍可能显示「豆包AI生成」，便于对照效果
- 📦 **自动解析**：页内面板加载成功后列出本会话已捕获的图片 / 视频
- ✨ **无水印标注**：条目显示「无水印图片 / 无水印视频」及分辨率、格式
- ⬇️ **单项下载**：每条资源右侧可一键下载无水印文件

### 2. 新生成图片：水印自动消失

插件就绪后，新生成的图片在对话页直接以无水印展示；页内面板「图片」Tab 同步收录为「无水印图片」。

![新生成图片无水印](https://s1.mnat.cn/2026/09/03/6a994187eba84.png)

- 🖼️ **对话内无水印**：新图在会话流中直接展示无水印原图，可继续用豆包原生下载
- 📑 **图片 Tab**：面板「图片」分类同步收录，标注「无水印图片」
- 📥 **全部下载**：底部支持当前分类一键全部下载；左侧可「支持作者」

同会话内连续生成多张图时，对话流与面板都会保持无水印状态：

![多图无水印与面板](https://s1.mnat.cn/2026/09/03/6a99418c382f9.png)

- 🔁 **连续生成**：同会话多轮出图仍保持无水印展示
- 📊 **数量角标**：面板 Tab 实时显示「图片 N / 视频 N」
- 🎬 **图视同管**：图片与视频分 Tab 管理，互不干扰

### 3. 一键下载 · 图片 / 视频分类

Popup 提供「全部 / 图片 / 视频」筛选、全选与**批量下载**；页内面板同样分 Tab，支持单项「下载」与「全部下载」。

![分类与批量下载](https://s1.mnat.cn/2026/09/03/6a99418ca320c.png)

- 🗂️ **三态筛选**：全部 / 图片 / 视频一键切换
- ✅ **全选批量**：勾选后点「批量下载」，支持混合队列
- 🃏 **卡片预览**：缩略图 + 分辨率 / 格式 / 时间；视频带「视频」角标
- 🗑️ **单条管理**：每张卡片可单独下载或删除本地记录

### 4. 全部会话资源管理

Popup 可按「会话标题 - Chat ID」切换，支持 **全部会话** 汇总本机已捕获的图片 / 视频（非豆包账号全量历史）。

![全部会话资源管理](https://s1.mnat.cn/2026/09/03/6a99418783755.png)

- 🧭 **按会话切换**：下拉选择「会话标题 - Chat ID」或「全部会话」
- 📚 **本机历史库**：汇总安装后打开 / 刷新过的会话媒体
- 🧹 **一键清空**：可清空当前筛选范围内的本地记录
- ⬇️ **批量下载**：与分类筛选组合使用，按需打包下载

### 5. 按类型筛选（视频）

切换到「视频」Tab 后只显示视频资源，可继续全选或单项下载。

![视频筛选](https://s1.mnat.cn/2026/09/03/6a99418cc0daa.png)

- 🎥 **仅视频视图**：过滤掉图片，专注无水印 MP4
- 🟢 **连接状态**：顶栏显示监听「已连接」，异常时可重连
- ▶️ **预览标识**：视频卡片含播放样式与「视频」角标
- ⬇️ **单项 / 批量**：支持单条下载或全选后批量下载

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
├── docs/
│   ├── testing.md
│   └── images/          # README 界面演示截图
├── doubaoparser/       # Chrome「加载已解压的扩展程序」选此目录
│   ├── icons/
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
