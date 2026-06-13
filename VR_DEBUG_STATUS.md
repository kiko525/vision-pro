# Vision Pro VR 模式调试状态

> 最后更新: 2026-01-24

## 项目概述
Vision Pro 3D 模型展示应用，支持 GLB 和 Gaussian Splat 模型在 WebXR VR 模式下查看。

---

## 已解决的问题 ✅

### 1. HTTPS 证书问题
- **问题**: Vision Pro Safari 要求 HTTPS，普通自签名证书被拒绝
- **解决方案**: 使用 `mkcert` 生成受信任的本地证书
- **证书位置**: `cert/localhost+4.pem`
- **CA 根证书**: 需安装到 Vision Pro 设备（`C:\Users\ACER\AppData\Local\mkcert\rootCA.pem`）

### 2. 手势权限提示不显示
- **问题**: Vision Pro 只显示"沉浸式体验"提示，不显示"手势跟踪"提示
- **解决方案**: 在 `js/vr-module.js` 第 161-165 行添加 `hand-tracking` 到 `optionalFeatures`

### 3. Splat 模型渲染
- **问题**: Gaussian Splat 模型在 VR 中不显示
- **解决方案**: 
  - 使用 `selfDrivenMode: false` 配置 splatViewer
  - 手动将 `splatMesh` 添加到 `vrScene`
  - 只调用 `splatViewer.update()`，不调用 `render()` 避免闪烁

### 4. XR 事件中 frame 为 null
- **问题**: `select` 事件中 `renderer.xr.getFrame()` 返回 null
- **解决方案**: 使用 `event.frame` 而不是 `renderer.xr.getFrame()`

---

## 当前未解决的问题 ❌

### 1. 射线检测失败 - 无法进入详情模式
**文件**: `js/vr-module.js` - `onSessionSelect()` 函数

**现象**:
- `select` 事件触发正常
- `targetRayPose` 存在（显示为 `{}`）
- 但无法获取 `transform.matrix` 进行射线设置

**调试日志**:
```
[VR] onSelect: 收到点击事件
[VR] onSelect: frame存在 = true, referenceSpace存在 = true
[VR] onSelect: targetRaySpace = {}, targetRayPose = {}
(然后没有后续日志)
```

**根本原因猜测**: Vision Pro 的 `transient-pointer` 的 `targetRayPose.transform.matrix` 结构可能与标准 WebXR 不同

### 2. 手部交互无法移动模型
**前置条件**: 需要先解决问题 #1

---

## 关键代码位置

| 功能 | 文件位置 |
|------|----------|
| VR 会话请求 | `js/vr-module.js` 第 153-180 行 |
| Splat Viewer 初始化 | `js/vr-module.js` 第 105-134 行 |
| 点击事件处理 | `js/vr-module.js` 第 1041-1120 行 |
| 单手移动交互 | `js/vr-module.js` 第 1300-1380 行 |
| 双手缩放旋转 | `js/vr-module.js` 第 1170-1250 行 |

---

## 下一步建议

1. **调试 targetRayPose 结构**: 添加 `JSON.stringify(targetRayPose.transform)` 查看完整结构
2. **参考官方示例**: https://webkit.org/blog/15162/introducing-natural-input-for-webxr-in-apple-vision-pro/
3. **考虑替代方案**: 使用 VR 相机的向前方向代替 targetRaySpace 进行射线检测

---

## 参考资源

- [WebKit WebXR Vision Pro 文档](https://webkit.org/blog/15162/introducing-natural-input-for-webxr-in-apple-vision-pro/)
- [GaussianSplats3D GitHub](https://github.com/mkkellogg/GaussianSplats3D)
- [WebXR Hand Input Module](https://www.w3.org/TR/webxr-hand-input-1/)
