# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [2.4.1] - 2026-09-03

### Added

- 豆包页加载成功后居中显示「插件已就绪 · 数据仅在本地处理」提示条

## [2.4.0] - 2026-09-03

### Added

- Popup 总开关「启用去水印」：关闭后停止图片 Hook、隐藏页内面板、断开视频 Debugger

### Changed

- 扩展显示名称改为「豆包图片视频去水印」，`short_name` 为 DoubaoWaterMark-Remover

## [2.3.2] - 2026-09-03

### Changed

- 扩展目录由 `extension/` 重命名为 `doubaoparser/`
- README 调整章节顺序，补充油猴安装说明

### Added

- `userscript/doubao-nomark-images.user.js`：Greasy Fork / Tampermonkey 图片无水印捕获与下载（视频仍需 Chrome 扩展）

### Notes

- 网页只响应媒体相关 DOM 变化；Fiber 扫描延后并缩小遍历范围
- Popup 分批渲染与缩略图懒加载
- 网页面板居中显示「加载成功」，最大高度约 320px
- 切换会话后短时间内识别尚未写入 `src` 的图片占位节点

### Fixed

- 图片记录必须包含原图字段，避免视频封面被误判为无水印图片

### Notes

- IndexedDB v4；图片与视频共用缓存上限（50 / 100 / 250 / 500 MB）

## [2.3.0] - 2026

### Added

- 图片与视频合并为同一扩展、同一 Popup、同一会话分类与缓存管理
- 豆包网页内嵌媒体面板（图片 / 视频 Tab）
- Popup：会话筛选、媒体类型筛选、批量下载、缓存整理
- 视频：Debugger 监听、最高画质、预览刷新临时地址、下载重试
