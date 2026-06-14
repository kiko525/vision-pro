// plyViewer.js - PLY高斯点云查看器模块
// 基于Gaussian Splats 3D库实现
// 支持两种模式：普通模式（独立查看器）和 VR 模式（集成到 Three.js）

import * as THREE from 'three';

// 全局变量
let viewer = null;
let viewerContainer = null;
let isVRMode = false;
let currentModelId = null;

/**
 * 检查Gaussian Splats 3D库是否可用
 */
async function checkGaussianSplatsAvailable() {
  try {
    const GaussianSplats3D = await import('@mkkellogg/gaussian-splats-3d');
    return !!GaussianSplats3D;
  } catch (error) {
    console.warn('Gaussian Splats 3D库未安装:', error);
    return false;
  }
}

/**
 * 加载PLY格式的高斯点云模型 - 普通模式（独立查看器，自带鼠标控制）
 * @param {string} path - 模型文件路径
 * @param {string|number} modelId - 模型ID
 * @param {Function} onProgress - 加载进度回调
 * @param {Object} options - 额外选项
 * @returns {Promise} - 返回Promise对象
 */
export async function loadPlyModel(path, modelId, onProgress, options = {}) {
  const { 
    onSuccess = () => {},
    onError = () => {},
    showLoading = () => {},
    hideLoading = () => {}
  } = options;
  
  // 检查库是否可用
  const isAvailable = await checkGaussianSplatsAvailable();
  
  if (!isAvailable) {
    console.warn('Gaussian Splats 3D库不可用，使用占位符');
    return createPlaceholder(path, modelId, onSuccess, onError);
  }
  
  return new Promise(async (resolve, reject) => {
    try {
      // 预检：文件不可用时直接抛错，避免 addSplatScene 拿到非点云数据后既不报错也不结束。
      await ensureSplatFileLoadable(path);
      const GaussianSplats3D = await import('@mkkellogg/gaussian-splats-3d');
      
      // 清理旧的查看器
      await cleanup();
      
      console.log('=== 普通模式：创建独立的 Gaussian Splats 查看器 ===');
      
      // 创建查看器容器
      const modelContainer = document.querySelector('.model-container');
      if (!modelContainer) {
        throw new Error('找不到模型容器元素');
      }
      
      viewerContainer = document.createElement('div');
      viewerContainer.id = 'viewer-container';
      viewerContainer.style.position = 'absolute';
      viewerContainer.style.top = '0';
      viewerContainer.style.left = '0';
      viewerContainer.style.width = '100%';
      viewerContainer.style.height = '100%';
      viewerContainer.style.zIndex = '1';
      modelContainer.appendChild(viewerContainer);
      
      // 隐藏原始canvas
      const originalCanvas = document.getElementById('model-canvas');
      if (originalCanvas) {
        originalCanvas.style.display = 'none';
      }
      
      // 初始化查看器（独立模式 - 自带鼠标控制）
      viewer = new GaussianSplats3D.Viewer({
        'rootElement': viewerContainer,
        'cameraUp': [0, 1, 0],
        'initialCameraPosition': [0, 1, 5],
        'initialCameraLookAt': [0, 0, 0],
        'useBuiltInControls': true,   // 启用内置鼠标控制
        'selfDrivenMode': true,        // 自动驱动渲染
        'dynamicScene': false,
        'sphericalHarmonicsDegree': 1,
        'renderMode': GaussianSplats3D.RenderMode.Always,
        'sharedMemoryForWorkers': false,
        'gpuAcceleratedSort': false,
        'webXRMode': GaussianSplats3D.WebXRMode.None  // 普通模式不启用 WebXR
      });
      
      console.log('✓ Gaussian Splats 查看器已创建（独立模式，内置鼠标控制）');
      
      // 确定文件格式
      const fileName = path.split('/').pop();
      const fileType = fileName.split('.').pop().toLowerCase();
      
      let format;
      if (fileType === 'ply') {
        format = GaussianSplats3D.SceneFormat.Ply;
      } else if (fileType === 'splat') {
        format = GaussianSplats3D.SceneFormat.Splat;
      } else if (fileType === 'ksplat') {
        format = GaussianSplats3D.SceneFormat.KSplat;
      } else if (fileType === 'spz') {
        format = GaussianSplats3D.SceneFormat.Spz;
      } else {
        throw new Error(`不支持的文件格式: ${fileType}`);
      }
      
      // 加载高斯点云数据
      await viewer.addSplatScene(path, {
        'format': format,
        'progressiveLoad': false,
        'showLoadingUI': false,
        'splatAlphaRemovalThreshold': 5,
        'onProgress': (progress) => {
          if (onProgress) {
            onProgress({ lengthComputable: true, loaded: progress, total: 100 });
          }
          
          if (progress >= 100) {
            hideLoading();
          }
        }
      });
      
      // 启动查看器
      viewer.start();
      
      // 获取点云数量
      const splatCount = viewer.getSplatMesh().getSplatCount();
      console.log(`✓ PLY模型加载成功，点数: ${splatCount}`);
      
      hideLoading();
      
      currentModelId = modelId;
      isVRMode = false;
      
      const result = {
        type: 'gaussian-splats',
        viewer: viewer,
        modelId,
        format: fileType,
        count: splatCount,
        mode: 'normal'
      };
      
      onSuccess(result);
      resolve(result);
      
    } catch (error) {
      console.error('加载PLY模型失败:', error);
      
      // 恢复原始canvas
      const originalCanvas = document.getElementById('model-canvas');
      if (originalCanvas) {
        originalCanvas.style.display = 'block';
      }
      
      await cleanup();
      
      onError(error.message || 'PLY模型加载失败');
      reject(error);
    }
  });
}

/**
 * 切换到 VR 模式
 * @param {Object} renderer - Three.js renderer
 * @param {Object} camera - Three.js camera  
 * @param {Object} scene - Three.js scene
 * @returns {Promise} - 返回Promise对象
 */
export async function enableVRMode(renderer, camera, scene) {
  if (!viewer || isVRMode) {
    console.warn('没有活动的查看器或已经在VR模式');
    return;
  }
  
  try {
    console.log('=== 切换到 VR 模式 ===');
    
    const GaussianSplats3D = await import('@mkkellogg/gaussian-splats-3d');
    
    // 停止独立查看器
    if (viewer.selfDrivenModeRunning) {
      viewer.stop();
    }
    
    // 获取当前场景数据
    const splatMesh = viewer.getSplatMesh();
    const sceneCount = viewer.getSceneCount();
    
    console.log(`当前有 ${sceneCount} 个场景`);
    
    // 保存当前模型路径（如果需要重新加载）
    const oldViewer = viewer;
    
    // 清理旧查看器
    await cleanup();
    
    // 创建新的 VR 模式查看器（集成到 Three.js）
    viewer = new GaussianSplats3D.Viewer({
      'selfDrivenMode': false,       // 由外部控制
      'renderer': renderer,
      'camera': camera,
      'threeScene': scene,
      'useBuiltInControls': false,   // 使用 Three.js 的控制
      'dynamicScene': true,
      'sphericalHarmonicsDegree': 1,
      'renderMode': GaussianSplats3D.RenderMode.Always,
      'sharedMemoryForWorkers': false,
      'gpuAcceleratedSort': false,
      'webXRMode': GaussianSplats3D.WebXRMode.VR  // 启用 VR
    });
    
    console.log('✓ VR 模式查看器已创建（集成到 Three.js）');
    
    // 重新加载场景（需要从外部传入路径）
    // 这里需要 app.js 重新调用加载
    
    isVRMode = true;
    
    return viewer;
    
  } catch (error) {
    console.error('切换到VR模式失败:', error);
    throw error;
  }
}

/**
 * 退出 VR 模式，恢复普通模式
 * @returns {Promise} - 返回Promise对象
 */
export async function disableVRMode() {
  if (!isVRMode) {
    console.warn('当前不在VR模式');
    return;
  }
  
  console.log('=== 退出 VR 模式 ===');
  
  // 清理 VR 查看器
  await cleanup();
  
  isVRMode = false;
  
  // 需要重新加载模型（普通模式）
  console.log('✓ 已退出VR模式，需要重新加载模型');
}

/**
 * 更新查看器（VR模式下每帧调用）
 */
export function update() {
  if (viewer && isVRMode) {
    viewer.update();
  }
}
// 新增：模块级辅助函数
async function ensureSplatFileLoadable(path) {
  let res;
  try {
    res = await fetch(path, { headers: { Range: 'bytes=0-63' }, cache: 'no-store' });
  } catch (e) {
    throw new Error(`无法获取模型文件: ${e.message || '网络错误'}`);
  }

  // 206 = Range 生效的部分内容；200 = 完整返回
  if (!res.ok && res.status !== 206) {
    throw new Error(`模型文件不存在或无法访问 (HTTP ${res.status})`);
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) {
    throw new Error('模型文件缺失：服务器返回了网页而非模型数据');
  }

  // 嗅探首字节，排除“状态 200 但内容是 HTML 回退页”
  try {
    const buf = await res.arrayBuffer();
    const head = new TextDecoder('utf-8', { fatal: false })
      .decode(new Uint8Array(buf).slice(0, 16))
      .trim()
      .toLowerCase();
    if (head.startsWith('<!doctype') || head.startsWith('<html')) {
      throw new Error('模型文件缺失：服务器返回了网页而非模型数据');
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('模型文件缺失')) throw e;
    // 嗅探读取失败本身不致命，交给后续 addSplatScene
  }
}
/**
 * 渲染查看器（VR模式下每帧调用）
 */
export function render() {
  if (viewer && isVRMode) {
    viewer.render();
  }
}

/**
 * 获取当前模式
 */
export function getMode() {
  return isVRMode ? 'vr' : 'normal';
}

/**
 * 创建占位符模型（当库不可用时）
 */
function createPlaceholder(path, modelId, onSuccess, onError) {
  return new Promise((resolve) => {
    const group = new THREE.Group();
    group.name = 'PLY_Placeholder_' + modelId;
    
    const geometry = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    const material = new THREE.MeshStandardMaterial({ 
      color: 0x00ff00,
      wireframe: true 
    });
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);
    
    const result = {
      type: 'gaussian-splats',
      object: group,
      modelId,
      format: 'ply',
      isPlaceholder: true
    };
    
    onSuccess(result);
    resolve(result);
  });
}

/**
 * 调整相机位置以显示完整模型（仅普通模式）
 */
function adjustCameraToModel() {
  if (!viewer || isVRMode) return;
  
  const splatMesh = viewer.getSplatMesh();
  if (!splatMesh || !splatMesh.scenes || !splatMesh.scenes[0]) return;
  
  const scene = splatMesh.scenes[0];
  const splatCount = splatMesh.getSplatCount();
  
  if (splatCount === 0) return;
  
  // 计算边界框
  const boundingBox = new THREE.Box3();
  const tempVector = new THREE.Vector3();
  
  try {
    boundingBox.setFromObject(scene);
  } catch (e) {
    // 如果失败，使用采样点计算
    const sampleSize = Math.min(splatCount, 1000);
    const step = Math.max(1, Math.floor(splatCount / sampleSize));
    
    for (let i = 0; i < splatCount; i += step) {
      const center = splatMesh.getSplatCenter(i);
      if (center && isFinite(center.x) && isFinite(center.y) && isFinite(center.z)) {
        tempVector.set(center.x, center.y, center.z);
        boundingBox.expandByPoint(tempVector);
      }
    }
  }
  
  // 计算大小和中心
  const size = new THREE.Vector3();
  boundingBox.getSize(size);
  const center = new THREE.Vector3();
  boundingBox.getCenter(center);
  
  // 居中模型
  scene.position.sub(center);
  scene.updateMatrixWorld(true);
  
  // 计算相机距离
  const maxDim = Math.max(size.x, size.y, size.z);
  const diagonal = Math.sqrt(size.x * size.x + size.y * size.y + size.z * size.z);
  
  const fov = viewer.camera.fov * (Math.PI / 180);
  let distance = Math.abs(diagonal / (2 * Math.tan(fov / 2))) * 2.0;
  distance = Math.max(Math.min(distance, 1000), 5);
  
  // 设置相机位置
  const cameraDirection = new THREE.Vector3(1.2, 0.6, 1).normalize();
  viewer.camera.position.copy(center).addScaledVector(cameraDirection, distance);
  viewer.camera.lookAt(center);
  
  if (viewer.controls) {
    viewer.controls.target.copy(center);
    viewer.controls.update();
  }
  
  viewer.camera.updateProjectionMatrix();
  viewer.forceRenderNextFrame();
}

/**
 * 重置相机视角（普通模式）
 */
export function resetCamera() {
  if (!viewer || isVRMode) {
    console.warn('没有活动的查看器或在VR模式下无法重置');
    return;
  }
  
  console.log('[PLY] 重置相机视角');
  
  const splatMesh = viewer.getSplatMesh();
  if (!splatMesh || !splatMesh.scenes || !splatMesh.scenes[0]) return;
  
  const scene = splatMesh.scenes[0];
  const splatCount = splatMesh.getSplatCount();
  
  if (splatCount === 0) return;
  
  // 计算边界框
  const boundingBox = new THREE.Box3();
  const tempVector = new THREE.Vector3();
  
  try {
    boundingBox.setFromObject(scene);
  } catch (e) {
    // 使用采样点计算
    const sampleSize = Math.min(splatCount, 1000);
    const step = Math.max(1, Math.floor(splatCount / sampleSize));
    
    for (let i = 0; i < splatCount; i += step) {
      const center = splatMesh.getSplatCenter(i);
      if (center && isFinite(center.x) && isFinite(center.y) && isFinite(center.z)) {
        tempVector.set(center.x, center.y, center.z);
        boundingBox.expandByPoint(tempVector);
      }
    }
  }
  
  // 计算大小和中心
  const size = new THREE.Vector3();
  boundingBox.getSize(size);
  const center = new THREE.Vector3();
  boundingBox.getCenter(center);
  
  // 计算相机距离
  const diagonal = Math.sqrt(size.x * size.x + size.y * size.y + size.z * size.z);
  const fov = viewer.camera.fov * (Math.PI / 180);
  let distance = Math.abs(diagonal / (2 * Math.tan(fov / 2))) * 2.0;
  distance = Math.max(Math.min(distance, 1000), 5);
  
  // 设置相机位置
  const cameraDirection = new THREE.Vector3(1.2, 0.6, 1).normalize();
  viewer.camera.position.copy(center).addScaledVector(cameraDirection, distance);
  viewer.camera.lookAt(center);
  
  if (viewer.controls) {
    viewer.controls.target.copy(center);
    viewer.controls.update();
  }
  
  viewer.camera.updateProjectionMatrix();
  viewer.forceRenderNextFrame();
  
  console.log('[PLY] 相机已重置');
}

/**
 * 清理资源
 */
export async function cleanup() {
  return new Promise((resolve) => {
    if (viewer) {
      try {
        if (viewer.selfDrivenModeRunning) {
          viewer.stop();
        }
        
        setTimeout(() => {
          try {
            if (viewer.getSceneCount && viewer.getSceneCount() > 0) {
              viewer.removeSplatScene(0).catch(() => {});
            }
            
            viewer.dispose();
          } catch (e) {
            console.warn('清理查看器时出错:', e);
          }
          
          viewer = null;
          
          // 移除容器
          if (viewerContainer && viewerContainer.parentNode) {
            viewerContainer.parentNode.removeChild(viewerContainer);
          }
          viewerContainer = null;
          
          // 恢复原始canvas
          const originalCanvas = document.getElementById('model-canvas');
          if (originalCanvas) {
            originalCanvas.style.display = 'block';
          }
          
          resolve();
        }, 100);
      } catch (e) {
        console.error('清理失败:', e);
        viewer = null;
        resolve();
      }
    } else {
      resolve();
    }
  });
}

/**
 * 获取当前查看器实例
 */
export function getViewer() {
  return viewer;
}

export default {
  loadPlyModel,
  enableVRMode,
  disableVRMode,
  resetCamera,
  update,
  render,
  getMode,
  cleanup,
  getViewer
};
