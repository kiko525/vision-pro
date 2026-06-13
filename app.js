// app.js
// Clean bootstrap for the WebXR model viewer.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import * as PlyViewer from './plyViewer.js';
import { VRModule } from './vr-module.js';

let scene;
let camera;
let renderer;
let controls;
let clock = new THREE.Clock();

let models = [];
let backgrounds = [];
let currentModelIndex = 0;
let currentModelType = null; // 'standard' | 'gaussian-splats'
let activeStandardObject = null;
let backgroundTexture = null;
let vrModule = null;

let isLoading = false;
let loadToken = 0;

const CONFIG = {
  camera: {
    fov: 50,
    near: 0.1,
    far: 5000,
    initPos: new THREE.Vector3(0, 1, 5)
  },
  controls: {
    minDistance: 0.1,
    maxDistance: 5000,
    damping: 0.07,
    azimuthSpan: Math.PI / 3
  },
  model: {
    idealSize: 20,
    minScaleClamp: 2,
    maxScaleClamp: 1000
  }
};

window.addEventListener('load', init);
window.addEventListener('resize', onWindowResize);

async function init() {
  try {
    initScene();

    await Promise.all([loadModelsList(), loadBackgroundsList()]);

    if (models.length > 0) {
      createThumbnails();
      await switchToModel(0);
    } else {
      showNoModelsMessage();
    }

    initControlButtons();
    await initVRMode();
  } catch (error) {
    console.error('[APP] init failed:', error);
    showError(`初始化失败: ${error.message || error}`);
  }
}

function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);

  camera = new THREE.PerspectiveCamera(
    CONFIG.camera.fov,
    window.innerWidth / window.innerHeight,
    CONFIG.camera.near,
    CONFIG.camera.far
  );
  camera.position.copy(CONFIG.camera.initPos);

  const canvas = document.getElementById('model-canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.xr.enabled = true;

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = CONFIG.controls.damping;
  controls.minDistance = CONFIG.controls.minDistance;
  controls.maxDistance = CONFIG.controls.maxDistance;
  controls.minPolarAngle = 0;
  controls.maxPolarAngle = Math.PI / 2;

  const azimuth = controls.getAzimuthalAngle();
  controls.minAzimuthAngle = azimuth - CONFIG.controls.azimuthSpan;
  controls.maxAzimuthAngle = azimuth + CONFIG.controls.azimuthSpan;

  const hemiLight = new THREE.HemisphereLight(0xddeeff, 0x202530, 0.6);
  scene.add(hemiLight);

  const mainLight = new THREE.DirectionalLight(0xffffff, 0.7);
  mainLight.position.set(1, 3, 2);
  mainLight.castShadow = true;
  scene.add(mainLight);

  const fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
  fillLight.position.set(-2, -1, 1);
  scene.add(fillLight);

  const ambientLight = new THREE.AmbientLight(0x404050, 0.5);
  scene.add(ambientLight);

  renderer.setAnimationLoop(render);

  window.controls = controls;
}

function render() {
  const delta = clock.getDelta();

  if (controls && !vrModule?.isVRMode) {
    controls.update();
  }

  if (vrModule) {
    vrModule.update(delta);
  }

  if (vrModule?.isVRMode) {
    renderer.render(vrModule.scene, vrModule.camera);
  } else {
    renderer.render(scene, camera);
  }
}

function onWindowResize() {
  if (!camera || !renderer) return;

  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

async function initVRMode() {
  try {
    vrModule = new VRModule(scene, camera, renderer);
    await vrModule.init();
  } catch (error) {
    console.error('[APP] VR module init failed:', error);
  }
}

async function toggleVRMode(mode = 'immersive-vr') {
  if (!vrModule) return;
  await vrModule.toggleVR(mode);
}

async function loadModelsList() {
  try {
    const res = await fetch('/api/models', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    models = await res.json();
  } catch (error) {
    console.error('[APP] load model list failed:', error);
    models = [];
  }
}

async function loadBackgroundsList() {
  try {
    const res = await fetch('/api/backgrounds', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    backgrounds = await res.json();
  } catch (error) {
    console.error('[APP] load background list failed:', error);
    backgrounds = [];
  }
}

function getModelPath(modelData) {
  return modelData.path.startsWith('/') ? modelData.path : `/${modelData.path}`;
}

function isGaussianSplatFormat(format) {
  const lower = (format || '').toLowerCase();
  return ['ply', 'splat', 'ksplat', 'spz'].includes(lower);
}

async function switchToModel(index) {
  if (!models.length) return;

  currentModelIndex = (index + models.length) % models.length;
  const modelData = models[currentModelIndex];

  updateModelInfo(modelData);
  await loadModel(modelData);
}

async function loadModel(modelData) {
  if (!modelData || isLoading) return;

  isLoading = true;
  const token = ++loadToken;

  showLoading('正在加载模型...');

  try {
    setSceneBackground(modelData.backgroundId);

    const format = (modelData.format || '').toLowerCase();
    const path = getModelPath(modelData);

    if (isGaussianSplatFormat(format)) {
      await loadGaussianSplatModel(path, modelData.id, token);
    } else {
      await loadStandardModel(path, format, token);
    }
  } catch (error) {
    if (token === loadToken) {
      console.error('[APP] load model failed:', error);
      showError(`模型加载失败: ${error.message || error}`);
    }
  } finally {
    if (token === loadToken) {
      hideLoading();
      isLoading = false;
    }
  }
}

async function loadGaussianSplatModel(path, modelId, token) {
  if (token !== loadToken) return;

  clearActiveStandardModel();

  // Switch into standalone splat viewer mode.
  currentModelType = 'gaussian-splats';
  await PlyViewer.cleanup();

  await PlyViewer.loadPlyModel(
    path,
    modelId,
    (xhr) => {
      if (token !== loadToken) return;
      if (xhr.lengthComputable) {
        const percent = Math.round((xhr.loaded / Math.max(xhr.total, 1)) * 100);
        showLoading(`正在加载点云: ${percent}%`);
      }
    },
    {
      onSuccess: (result) => {
        if (token !== loadToken) return;
        if (result?.isPlaceholder && result.object) {
          scene.add(result.object);
          activeStandardObject = result.object;
        }
      },
      onError: (error) => {
        if (token !== loadToken) return;
        throw new Error(error || 'Gaussian splat load failed');
      },
      showLoading,
      hideLoading
    }
  );
}

async function loadStandardModel(path, format, token) {
  if (token !== loadToken) return;

  currentModelType = 'standard';

  // Leave standalone splat viewer if active.
  await PlyViewer.cleanup();

  clearActiveStandardModel();

  let object = null;
  switch (format) {
    case 'glb':
    case 'gltf':
      object = await loadGLTF(path, token);
      break;
    case 'obj':
      object = await loadOBJ(path, token);
      break;
    case 'stl':
      object = await loadSTL(path, token);
      break;
    case 'fbx':
      object = await loadFBX(path, token);
      break;
    default:
      throw new Error(`不支持的模型格式: ${format}`);
  }

  if (!object || token !== loadToken) return;

  scene.add(object);
  activeStandardObject = object;
  resetCameraForModel(object);
}

function loadGLTF(path, token) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath('/node_modules/three/examples/jsm/libs/draco/gltf/');
    loader.setDRACOLoader(dracoLoader);

    loader.load(
      path,
      (gltf) => {
        if (token !== loadToken) {
          dracoLoader.dispose?.();
          resolve(null);
          return;
        }

        const object = gltf.scene;
        normalizeAndOrientModel(object, 'gltf');
        applyShadowFlags(object);
        dracoLoader.dispose?.();
        resolve(object);
      },
      (xhr) => {
        if (token !== loadToken || !xhr.lengthComputable) return;
        const percent = Math.round((xhr.loaded / Math.max(xhr.total, 1)) * 100);
        showLoading(`正在加载模型: ${percent}%`);
      },
      (error) => {
        dracoLoader.dispose?.();
        reject(error);
      }
    );
  });
}

function loadOBJ(path, token) {
  return new Promise((resolve, reject) => {
    const loader = new OBJLoader();
    loader.load(
      path,
      (object) => {
        if (token !== loadToken) {
          resolve(null);
          return;
        }
        normalizeAndOrientModel(object, 'obj');
        applyShadowFlags(object);
        resolve(object);
      },
      undefined,
      reject
    );
  });
}

function loadSTL(path, token) {
  return new Promise((resolve, reject) => {
    const loader = new STLLoader();
    loader.load(
      path,
      (geometry) => {
        if (token !== loadToken) {
          geometry.dispose();
          resolve(null);
          return;
        }

        const material = new THREE.MeshStandardMaterial({
          color: 0xcccccc,
          metalness: 0.2,
          roughness: 0.8,
          flatShading: true,
          side: THREE.DoubleSide
        });

        const mesh = new THREE.Mesh(geometry, material);
        normalizeAndOrientModel(mesh, 'stl');
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        resolve(mesh);
      },
      undefined,
      reject
    );
  });
}

function loadFBX(path, token) {
  return new Promise((resolve, reject) => {
    const loader = new FBXLoader();
    loader.load(
      path,
      (object) => {
        if (token !== loadToken) {
          resolve(null);
          return;
        }

        object.scale.setScalar(0.01);
        normalizeAndOrientModel(object, 'fbx');
        applyShadowFlags(object);
        resolve(object);
      },
      undefined,
      reject
    );
  });
}

function applyShadowFlags(object) {
  object.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

function normalizeAndOrientModel(object, format) {
  if (!object) return;

  switch ((format || '').toLowerCase()) {
    case 'obj':
    case 'stl':
      object.rotation.x = -Math.PI / 2;
      break;
    case 'gltf':
    case 'glb':
    case 'fbx':
      object.rotation.y = Math.PI;
      break;
    default:
      break;
  }

  object.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);

  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 0) {
    const scaleFactor = CONFIG.model.idealSize / maxDim;
    object.scale.multiplyScalar(scaleFactor);
  }

  object.updateMatrixWorld(true);
}

function clearActiveStandardModel() {
  if (!activeStandardObject) {
    return;
  }

  if (activeStandardObject.parent) {
    activeStandardObject.parent.remove(activeStandardObject);
  }

  disposeObject3D(activeStandardObject);
  activeStandardObject = null;
}

function disposeObject3D(object) {
  if (!object) return;

  object.traverse((child) => {
    if (child.geometry) {
      child.geometry.dispose();
    }

    if (child.material) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of materials) {
        if (!mat) continue;
        if (mat.map) mat.map.dispose();
        if (mat.normalMap) mat.normalMap.dispose();
        if (mat.roughnessMap) mat.roughnessMap.dispose();
        if (mat.metalnessMap) mat.metalnessMap.dispose();
        if (mat.emissiveMap) mat.emissiveMap.dispose();
        mat.dispose();
      }
    }
  });
}

function resetCameraForModel(object) {
  if (currentModelType === 'gaussian-splats') {
    PlyViewer.resetCamera();
    return;
  }

  if (!object) return;

  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);

  if (box.isEmpty()) {
    return;
  }

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  if (object.parent === scene && center.length() > 0.01) {
    object.position.sub(center);
    object.updateMatrixWorld(true);
  }

  const diagonal = size.length();
  const fov = camera.fov * (Math.PI / 180);
  let distance = Math.abs(diagonal / (2 * Math.tan(fov / 2))) * 1.5;
  distance = THREE.MathUtils.clamp(distance, CONFIG.model.minScaleClamp, CONFIG.model.maxScaleClamp);

  camera.position.set(distance * 0.5, distance * 0.5, distance * 0.5);
  controls.target.set(0, 0, 0);
  controls.update();
}

function setSceneBackground(backgroundId) {
  const bgId = backgroundId ? parseInt(backgroundId, 10) : null;
  const modelContainer = document.querySelector('.model-container');

  if (backgroundTexture) {
    backgroundTexture.dispose();
    backgroundTexture = null;
  }

  if (!bgId) {
    scene.background = new THREE.Color(0x111111);
    if (modelContainer) {
      modelContainer.style.background = '#111111';
      modelContainer.style.backgroundImage = 'none';
    }
    return;
  }

  const background = backgrounds.find((item) => item.id === bgId);
  if (!background || !background.path) {
    scene.background = new THREE.Color(0x111111);
    if (modelContainer) {
      modelContainer.style.background = '#111111';
      modelContainer.style.backgroundImage = 'none';
    }
    return;
  }

  const loader = new THREE.TextureLoader();
  loader.load(
    background.path,
    (texture) => {
      backgroundTexture = texture;
      scene.background = texture;
      if (modelContainer) {
        modelContainer.style.backgroundImage = `url(${background.path})`;
        modelContainer.style.backgroundSize = 'cover';
        modelContainer.style.backgroundPosition = 'center';
      }
    },
    undefined,
    (error) => {
      console.error('[APP] background load failed:', error);
      scene.background = new THREE.Color(0x111111);
    }
  );
}

function initControlButtons() {
  const prevBtn = document.getElementById('prev-model');
  const nextBtn = document.getElementById('next-model');
  const resetBtn = document.getElementById('reset-camera');
  const fullscreenBtn = document.getElementById('fullscreen');

  if (prevBtn) prevBtn.addEventListener('click', () => void switchToModel(currentModelIndex - 1));
  if (nextBtn) nextBtn.addEventListener('click', () => void switchToModel(currentModelIndex + 1));

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      resetBtn.classList.add('active');
      if (currentModelType === 'gaussian-splats') {
        PlyViewer.resetCamera();
      } else {
        resetCameraForModel(activeStandardObject);
      }
      setTimeout(() => resetBtn.classList.remove('active'), 280);
    });
  }

  if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', toggleFullscreen);
  }

  document.addEventListener('fullscreenchange', handleFullscreenChange);
  document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
  handleFullscreenChange();

  window.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') void switchToModel(currentModelIndex - 1);
    if (event.key === 'ArrowRight') void switchToModel(currentModelIndex + 1);
    if (event.key === 'c' || event.key === 'C') {
      if (currentModelType === 'gaussian-splats') {
        PlyViewer.resetCamera();
      } else {
        resetCameraForModel(activeStandardObject);
      }
    }
    if (event.key === 'f' || event.key === 'F') {
      toggleFullscreen();
    }
  });
}

function isFullscreenActive() {
  return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
}

function toggleFullscreen() {
  const container = document.querySelector('.model-container');
  if (!container) return;

  const requestFullscreen = container.requestFullscreen || container.webkitRequestFullscreen;
  const exitFullscreen = document.exitFullscreen || document.webkitExitFullscreen;

  if (!isFullscreenActive()) {
    if (!requestFullscreen) return;
    requestFullscreen.call(container).catch((error) => {
      console.error('[APP] enter fullscreen failed:', error);
    });
  } else {
    if (!exitFullscreen) return;
    exitFullscreen.call(document).catch((error) => {
      console.error('[APP] exit fullscreen failed:', error);
    });
  }

  setTimeout(onWindowResize, 280);
}

function handleFullscreenChange() {
  const fullscreenBtn = document.getElementById('fullscreen');
  if (!fullscreenBtn) return;

  const fullscreen = isFullscreenActive();
  fullscreenBtn.classList.toggle('active', fullscreen);
  fullscreenBtn.title = fullscreen ? '退出全屏' : '进入全屏';
  fullscreenBtn.setAttribute('aria-label', fullscreen ? '退出全屏' : '进入全屏');
}

function createThumbnails() {
  const container = document.getElementById('thumbnails-container');
  if (!container) return;

  container.innerHTML = '';

  models.forEach((model, index) => {
    const thumbnail = document.createElement('div');
    thumbnail.className = `thumbnail${index === currentModelIndex ? ' active' : ''}`;

    if (model.thumbnail) {
      thumbnail.style.backgroundImage = `url(${model.thumbnail})`;
    }

    thumbnail.addEventListener('click', () => {
      void switchToModel(index);
    });

    container.appendChild(thumbnail);
  });
}

function updateModelInfo(modelData) {
  const nameElement = document.getElementById('model-name');
  const descElement = document.getElementById('model-desc');

  if (nameElement) {
    nameElement.textContent = modelData?.name || '';
  }

  // 只添加这 3 行
  const formatElement = document.getElementById('model-format');
  if (formatElement) {
    formatElement.textContent = modelData?.format ? `格式: ${modelData.format.toUpperCase()}` : '格式: -';
  }

  if (descElement) {
    descElement.textContent = modelData?.description || '';
  }

  document.querySelectorAll('.thumbnail').forEach((thumbnail, idx) => {
    thumbnail.classList.toggle('active', idx === currentModelIndex);
  });
}

function showLoading(text = '加载中...') {
  const overlay = document.querySelector('.loading-overlay');
  if (!overlay) return;

  overlay.style.display = 'flex';
  const textElement = overlay.querySelector('.loading-text');
  if (textElement) {
    textElement.textContent = text;
  }
}

function hideLoading() {
  const overlay = document.querySelector('.loading-overlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
}

function showError(message) {
  console.error('[APP]', message);

  const errorDiv = document.createElement('div');
  errorDiv.style.position = 'fixed';
  errorDiv.style.top = '50%';
  errorDiv.style.left = '50%';
  errorDiv.style.transform = 'translate(-50%, -50%)';
  errorDiv.style.background = 'rgba(220, 38, 38, 0.95)';
  errorDiv.style.color = '#fff';
  errorDiv.style.padding = '24px 32px';
  errorDiv.style.borderRadius = '12px';
  errorDiv.style.zIndex = '10000';
  errorDiv.style.maxWidth = '80%';
  errorDiv.style.textAlign = 'center';
  errorDiv.style.boxShadow = '0 10px 40px rgba(0, 0, 0, 0.3)';
  errorDiv.style.backdropFilter = 'blur(10px)';
  errorDiv.style.lineHeight = '1.6';
  errorDiv.style.whiteSpace = 'pre-line';
  errorDiv.style.fontSize = '16px';

  const icon = document.createElement('div');
  icon.innerHTML = '<svg width="48" height="48" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="#fff" d="M12 2.75 1.75 20.5h20.5L12 2.75Zm0 4.1 6.46 11.15H5.54L12 6.85Zm-.75 3.4v4.9h1.5v-4.9h-1.5Zm0 6.4v1.45h1.5v-1.45h-1.5Z"/></svg>';
  errorDiv.appendChild(icon);

  const text = document.createElement('div');
  text.textContent = message;
  errorDiv.appendChild(text);

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '知道了';
  closeBtn.style.marginTop = '18px';
  closeBtn.style.padding = '10px 26px';
  closeBtn.style.background = 'rgba(255, 255, 255, 0.2)';
  closeBtn.style.border = '1px solid rgba(255, 255, 255, 0.3)';
  closeBtn.style.borderRadius = '6px';
  closeBtn.style.color = '#fff';
  closeBtn.style.cursor = 'pointer';
  closeBtn.style.fontSize = '14px';
  closeBtn.style.fontWeight = '700';
  closeBtn.onclick = () => errorDiv.remove();
  errorDiv.appendChild(closeBtn);

  document.body.appendChild(errorDiv);

  setTimeout(() => {
    if (errorDiv.parentNode) {
      errorDiv.style.opacity = '0';
      errorDiv.style.transition = 'opacity 0.3s';
      setTimeout(() => errorDiv.remove(), 300);
    }
  }, 5000);
}

function showNoModelsMessage() {
  hideLoading();

  const message = document.createElement('div');
  message.style.position = 'absolute';
  message.style.top = '50%';
  message.style.left = '50%';
  message.style.transform = 'translate(-50%, -50%)';
  message.style.background = 'rgba(0, 0, 0, 0.7)';
  message.style.color = '#fff';
  message.style.padding = '20px 30px';
  message.style.borderRadius = '8px';
  message.style.textAlign = 'center';
  message.style.zIndex = '1000';

  message.innerHTML = '<svg width="48" height="48" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="#ff9800" d="M12 2.75A9.25 9.25 0 1 0 21.25 12 9.26 9.26 0 0 0 12 2.75Zm0 1.5A7.75 7.75 0 1 1 4.25 12 7.76 7.76 0 0 1 12 4.25Zm-.75 4.1v6.1h1.5v-6.1h-1.5Zm0 7.6v1.7h1.5v-1.7h-1.5Z"/></svg><div style="margin-top: 15px; font-size: 20px; font-weight: bold;">暂无模型，请先上传模型</div>';

  const container = document.querySelector('.model-container');
  if (container) {
    container.appendChild(message);
  }
}

window._app = {
  switchToModel,
  toggleVRMode,
  models: () => models,
  scene: () => scene,
  camera: () => camera,
  controls: () => controls,
  vrModule: () => vrModule
};
