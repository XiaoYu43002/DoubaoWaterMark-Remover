# Chrome 网上应用店上架说明

## 目录约定

| 路径 | 用途 |
|------|------|
| `doubaoparser/` | 扩展源码（加载已解压 / 打包输入） |
| `extension/` | 可选本地联接，指向 `doubaoparser`（gitignore） |
| `tools/pack-chrome-extension.ps1` | 一键打 ZIP |
| `release/*.zip` | 打包产物（已 gitignore，勿提交） |
| `store/` | 商店文案、隐私政策草稿 |

**加载已解压扩展**：选 `doubaoparser`（或本地的 `extension`）。  
**上传商店**：必须上传 ZIP，且 **ZIP 根目录直接是 `manifest.json`**，不要把整个仓库打进包。

## 一键打包

在仓库根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File tools/pack-chrome-extension.ps1
```

生成：`release/doubao-original-media-helper-<version>.zip`

## 开发者控制台步骤（摘要）

1. [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) 注册开发者（一次性费用）
2. **新商品** → 上传上面的 ZIP
3. 填写商店详情（**文案见 [LISTING.md](./LISTING.md)，可直接复制粘贴**）
4. 上传截图：至少 **1280×800** 或 **640×400**（建议 1280×800，PNG/JPEG）
5. 小图标：商店会用 manifest 里的 **128×128**
6. 隐私：填写 [privacy-policy.md](./privacy-policy.md) 托管后的公开 URL（GitHub Pages / 仓库 raw / 个人站点均可）
7. **单一用途**：见 LISTING.md 第 5 节
8. **权限说明**：见 LISTING.md 第 6 节  
9. 提交审核

## 商店文案位置

→ **[LISTING.md](./LISTING.md)**（名称、摘要、详细说明、权限理由、截图清单）

## 商店名称 / 简介（速览）

- **名称**：豆包AI生成图片与视频无感去水印  
- **简短说明**：见 LISTING.md「摘要」  
- **详细说明**：见 LISTING.md「详细说明」

## 审核注意

- 自 2.6.0 起已移除 `debugger`，审核压力更小；文案与隐私政策勿再写调试器。  
- 包内不要包含无关仓库文件（打包脚本已只打扩展文件）。  
- 每次改代码后先改 `manifest.json` 的 `version`，再重新打包上传。
