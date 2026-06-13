# Vision Pro 3D/VR 互动展示模块 项目开发文档

## 1. 项目简介
本项目是一个基于 Web 技术的 3D 模型和 Gaussian Splat (3D 高斯泼溅) 互动展示平台。其核心特色在于**深度集成了针对 Apple Vision Pro (visionOS) 优化的 WebXR 沉浸式 VR 体验**。
项目支持标准的 GLB 模型以及先进的 `.splat`、`.ply` 格式，允许用户在浏览器或沉浸式 VR 头显中进行查看、选择和自然手势交互（捏合拖拽、双手缩放旋转）。

---

## 2. 技术栈核心
*   **前端渲染**: [Three.js](https://threejs.org/) (r160) - 构建 3D 场景和基础 WebXR 架构。
*   **高斯渲染**: [GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D) - 专业加载和渲染高斯泼溅模型的核心库。
*   **后端服务**: Node.js + Express - 提供静态资源托管及本地 HTTPS 开发环境。
*   **VR 交互**: 原生 WebXR API (`immersive-vr`, `hand-tracking`, `local-floor`)。

---

## 3. 核心架构与模块说明

项目主要由两个前端模块协作完成：

### 3.1 主应用逻辑 (`js/app.js`)
负责 PC 端和移动端浏览器的标准 3D 展示。
- **初始化模型环境**: 解析从服务端获取的模型列表。
- **场景搭建**: 管理 Three.js 场景、灯光、标准鼠标/触摸交互控制 (`OrbitControls`)。
- **UI 管理**: 底部模型缩略图画廊 (`ThumbSlider`) 显示，右侧详细信息面板 (`InfoPanel`) 的更新。

### 3.2 独立 VR 模块 (`js/vr-module.js`) - **本项目技术核心**
接管进入沉浸式 VR 模式后的所有逻辑。它与主场景隔离，独立管理其生命周期以满足 visionOS 的苛刻要求。

#### **关键职责：**
1.  **权限申请与会话管理**:
    通过 `navigator.xr.requestSession('immersive-vr')` 请求 VR 模式。
    针对 Vision Pro，必须显式请求 `optionalFeatures: ['hand-tracking', 'bounded-floor']` 才能触发系统级的自然交互权限提示。
2.  **双模式渲染隔离**:
    - **GLB 模型**: 由 WebXRManager (Three.js 默认) 处理渲染。
    - **Splat 模型**: 配置 GaussianSplats3D 为 `selfDrivenMode: false`。在 XR 渲染循环中通过 `this.renderer.xr.setAnimationLoop` 控制，通过 `splatViewer.update()` 刷新深度排序，由外部统一提交渲染帧，避免双重视角冲突闪烁。
3.  **UI 沉浸化处理**:
    在三维空间中动态生成包含图片、文字信息、按钮的网格 (`THREE.Mesh`) 作为信息面板，让用户在 VR 中阅读模型描述和进行操作。

---

## 4. 攻克 Vision Pro WebXR 的深水区 (手势与射线)

在开发过程中，针对 Apple Vision Pro (visionOS 2) 的原生交互范式 ("Look and Pinch" 眼指协同) 进行了深度定制，这是传统依赖手柄的 WebXR 教程不具备的。也是本机型的核心技术难点。

### 4.1 "眼+捏" 射线检测 (Raycasting) 的适配
在标准 WebXR 中，控制器会发射持续的射线。但在 Vision Pro 控制流中，交互源模式为 `transient-pointer`，即"瞬时指针"（捏合瞬间才产生）。

*   **问题**: `targetRayPose` 的 Transform 矩阵在不同环境或阶段可能出现不可读 (`undefined/null` 或结构不完整) 现象，导致光线投射 (Raycast) 验证失败。
*   **重构方案**:
    在 `onSessionSelect`（捏合点击事件）中：
    1. 获取真实的事件帧 `event.frame` (由于 select 事件可能不在动画循环内触发，`renderer.xr.getFrame()` 会为空)。
    2. 优先尝试从 `transient-pointer` 提取 `targetRayPose` 构建射线。
    3. **降级策略 (Fallback)**: 若 `targetRayPose` 矩阵提取失败，则直接采用当前 **VR 摄影机的位置和面朝方向 (`getWorldPosition`/`getWorldDirection`)** 作为射线原点和方向。这与 Apple 倡导的"注视高亮"逻辑 100% 契合。

### 4.2 空间交互：单手移动与双手缩放/旋转
Vision Pro 对捏合的追踪 `handedness` 经常返回 `"none"`，这使得无法用传统 "left/right" 区分双手。

*   **问题**: 单手移动时，依赖三维坐标偏差会造成在父级转换或用户平移时发生模型漂移。
*   **重构方案**: 
    - 抛弃 `targetRaySpace`，改用真实的手部位姿表示 **`gripSpace`** 进行抓取。
    - **单手位移 (Delta Matrix 计算)**: 使用严格的 4x4 矩阵乘法。记录上一帧抓取矩阵，与当前帧计算出 `deltaMatrix` (当前帧矩阵 * 逆矩阵)，直接 `applyMatrix4` 更新给模型。
    - **双手缩放/旋转**: 获取两个 `transient-pointer` 的 `gripSpace` 坐标。计算两点距离比率来缩放，计算 XY/XZ 平面对应角度的改变来进行 Y 轴旋转。对于 Splat 模型，通过 `setSplatSceneOptions` API 将欧拉角转化为四元数 (`Quaternion`) 进行实时同步更新。

---

## 5. 项目环境与启动要求

由于高斯模型 (`SharedArrayBuffer` 要求) 和 WebXR 的安全限制，本项目必须运行在严格的安全上下文中。

### 5.1 本地 HTTPS 与跨源隔离 (Cross-Origin Isolation)
1. **服务端响应头 (`server.js`)**: 
   强制注入以下 Header 以启用 SharedArrayBuffer 解析 Splat：
   - `Cross-Origin-Opener-Policy: same-origin`
   - `Cross-Origin-Embedder-Policy: require-corp`
2. **本地 HTTPS 服务**:
   使用 `mkcert` 工具生成的本地受信任证书。在 `server.js` 中启用了 HTTPS 服务器并附带证书校验提示功能。 
   *运行前必须在 Windows 开发机和 Apple Vision Pro 的设置中信任 `rootCA.pem` 根证书。*

### 5.2 启动命令
```bash
npm install
npm run cert
npm run dev
```

`npm run cert` 现在会优先使用 `mkcert`，并生成以下文件：

- `cert/mkcert-cert.pem`
- `cert/mkcert-key.pem`
- `cert/rootCA.pem`
- `cert/rootCA.cer`

在 Apple Vision Pro 上需要安装并信任 `cert/rootCA.cer`。
如果只是临时本机调试，仍可使用 `npm run cert:selfsigned` 生成旧的自签名证书。

---

## 6. 未来维护者须知 (TODO & 注意点)

1.  **高斯模型性能限制**: 多个高分 Splat 模型同时加载会极高消耗 VRAM (显存)。当前页面采用“详情切换”逻辑展示单一模型。不要尝试一次性渲染整个画廊的高分辨率 Splat。
2.  **更新 Three.js 版本**: 项目依赖特定的 Three r160 API。如未来升级 Three.js，须密切关注 `WebXRManager` 控制器获取机制的变化。
3.  **调试技巧**: 使用了 WebSocket 将前端日志重传至 VSCode Terminal。由于 Vision Pro 设备内无法轻易连接 DevTools，遇到 VR 问题时优先查看终端的 `[VR]` 标签日志。
