// vr-module.js
// WebXR module for Vision Pro optimized VR/MR workflows.
// Key compatibility goals:
// 1) Handle AVP transient-pointer ray fallback.
// 2) Use gripSpace matrix-delta movement for one-hand translation.
// 3) Keep GaussianSplats3D in selfDrivenMode=false and update from the shared XR loop only.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

const STATE = {
  GALLERY: 0,
  DETAIL: 1
};

const XR_MODE = {
  VR: 'immersive-vr',
  AR: 'immersive-ar'
};

const DETAIL_ANCHOR = new THREE.Vector3(0, 1.3, -2.0);
const GALLERY_RADIUS = 2.0;
const GALLERY_HEIGHT = 1.3;
const GALLERY_SCALE = 0.45;
const MIN_PROXY_SIZE = 0.2;
const MIN_MODEL_SCALE = 0.1;
const MAX_MODEL_SCALE = 10.0;

export class VRModule {
  constructor(scene, camera, renderer) {
    this.externalScene = scene;
    this.externalCamera = camera;
    this.renderer = renderer;

    this.scene = scene;
    this.camera = camera;

    this.vrScene = null;
    this.vrCamera = null;
    this.vrSession = null;

    this.xrMode = XR_MODE.VR;
    this.pendingSessionMode = XR_MODE.VR;
    this.isVRMode = false;
    this.isMRMode = false;
    this.isSessionTransitioning = false;

    this.currentState = STATE.GALLERY;

    this.splatViewer = null;
    this.GaussianSplats3D = null;
    this.activeSplatSceneIndexes = new Set();

    this.modelsData = [];
    this.galleryGroup = null;
    this.galleryItems = [];
    this.hitBoxes = [];
    this.hoveredItem = null;

    this.detailModel = null;
    this.detailModelType = null;
    this.detailSplatIndex = null;
    this.backButton = null;
    this.infoPanel = null;

    this.shadowCatcher = null;
    this.occlusionPlane = null;

    this.controller0 = null;
    this.controller1 = null;

    this.raycaster = new THREE.Raycaster();

    // Interaction states for AVP transient-pointer gestures.
    this.lastGripMatrices = new Map();
    this.initialPinchDistance = 0;
    this.initialModelScale = null;
    this.lastRotationAngle = null;

    this.savedBackground = null;
    this.savedClearAlpha = 1;

    this.vrSupported = false;
    this.arSupported = false;

    this.onSessionSelectBound = (event) => this.onSessionSelect(event);
    this.onSessionSelectStartBound = (event) => this.onSessionSelectStart(event);
    this.onSessionSelectEndBound = (event) => this.onSessionSelectEnd(event);
    this.onInputSourcesChangeBound = () => this.onInputSourcesChange();

    this.rendererSessionStartBound = () => {
      void this.onRendererSessionStart();
    };
    this.rendererSessionEndBound = () => {
      void this.onRendererSessionEnd();
    };
  }

  async init() {
    this.renderer.xr.enabled = true;

    if (!navigator.xr) {
      this.setupButtons(false, false);
      return false;
    }

    try {
      const [vrSupported, arSupported] = await Promise.all([
        navigator.xr.isSessionSupported(XR_MODE.VR).catch(() => false),
        navigator.xr.isSessionSupported(XR_MODE.AR).catch(() => false)
      ]);

      this.vrSupported = Boolean(vrSupported);
      this.arSupported = Boolean(arSupported);

      this.setupButtons(this.vrSupported, this.arSupported);

      this.renderer.xr.addEventListener('sessionstart', this.rendererSessionStartBound);
      this.renderer.xr.addEventListener('sessionend', this.rendererSessionEndBound);

      return this.vrSupported || this.arSupported;
    } catch (error) {
      console.error('[XR] init failed:', error);
      this.setupButtons(false, false);
      return false;
    }
  }

  setupButtons(vrSupported, arSupported) {
    const vrBtn = document.getElementById('vr-mode-btn');
    const mrBtn = document.getElementById('mr-mode-btn');

    if (vrBtn) {
      vrBtn.onclick = null;
      if (vrSupported) {
        vrBtn.style.opacity = '1';
        vrBtn.title = '进入 VR 模式';
        vrBtn.onclick = () => {
          void this.toggleVR(XR_MODE.VR);
        };
      } else {
        vrBtn.style.opacity = '0.45';
        vrBtn.title = '当前设备不支持 VR';
        vrBtn.onclick = () => this.showVRNotSupportedDialog();
      }
    }

    if (mrBtn) {
      mrBtn.onclick = null;
      if (arSupported) {
        mrBtn.style.opacity = '1';
        mrBtn.title = '进入 MR 模式';
        mrBtn.onclick = () => {
          void this.toggleVR(XR_MODE.AR);
        };
      } else {
        mrBtn.style.opacity = '0.45';
        mrBtn.title = '当前设备不支持 MR';
        mrBtn.onclick = () => this.showMRNotSupportedDialog();
      }
    }
  }

  async toggleVR(mode = XR_MODE.VR) {
    if (this.isSessionTransitioning) {
      console.warn('[XR] transition already in progress, request ignored');
      return;
    }

    const supported = mode === XR_MODE.AR ? this.arSupported : this.vrSupported;
    if (!supported) {
      if (mode === XR_MODE.AR) {
        this.showMRNotSupportedDialog();
      } else {
        this.showVRNotSupportedDialog();
      }
      return;
    }

    this.isSessionTransitioning = true;

    try {
      if (this.vrSession) {
        if (this.xrMode === mode) {
          await this.endActiveSession();
          return;
        }

        await this.endActiveSession();
      }

      await this.requestXRSession(mode);
    } catch (error) {
      console.error(`[XR] failed to toggle session (${mode}):`, error);
    } finally {
      this.isSessionTransitioning = false;
    }
  }

  async requestXRSession(mode) {
    const optionalFeatures = ['hand-tracking'];
    if (mode === XR_MODE.VR) {
      optionalFeatures.push('bounded-floor');
    }

    this.pendingSessionMode = mode;

    const session = await navigator.xr.requestSession(mode, {
      requiredFeatures: ['local-floor'],
      optionalFeatures
    });

    this.renderer.xr.setReferenceSpaceType('local-floor');
    this.renderer.xr.setFramebufferScaleFactor(1.0);

    await this.renderer.xr.setSession(session);
    this.vrSession = session;
  }

  async endActiveSession() {
    if (!this.vrSession) {
      return;
    }

    const session = this.vrSession;

    await new Promise((resolve) => {
      let settled = false;

      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const onEnd = () => {
        session.removeEventListener('end', onEnd);
        finish();
      };

      session.addEventListener('end', onEnd, { once: true });

      session.end().catch((error) => {
        console.warn('[XR] session.end() rejected:', error);
        finish();
      });

      setTimeout(() => {
        session.removeEventListener('end', onEnd);
        finish();
      }, 2000);
    });
  }

  async onRendererSessionStart() {
    this.xrMode = this.pendingSessionMode || XR_MODE.VR;
    this.isMRMode = this.xrMode === XR_MODE.AR;
    this.isVRMode = true;

    this.vrScene = new THREE.Scene();
    this.vrCamera = this.externalCamera.clone();

    this.scene = this.vrScene;
    this.camera = this.vrCamera;

    this.saveNormalModeState();

    if (this.isMRMode) {
      // AR passthrough needs a transparent clear.
      this.vrScene.background = null;
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.setClearAlpha(0);
    } else {
      this.vrScene.background = new THREE.Color(0x000000);
      this.renderer.setClearColor(0x000000, 1);
      this.renderer.setClearAlpha(1);
    }

    this.setupXRLighting();

    if (this.isMRMode) {
      this.createMRGroundPlanes();
    }

    await this.initSplatViewer();

    this.setupSessionInputHandling();

    this.currentState = STATE.GALLERY;
    await this.fetchModelsData();

    console.log(`[XR] session started in ${this.isMRMode ? 'MR' : 'VR'} mode`);
  }

  async onRendererSessionEnd() {
    const previousMode = this.xrMode;

    this.isVRMode = false;
    this.isMRMode = false;
    this.vrSession = null;

    this.removeSessionInputHandling();
    this.clearInteractionState();

    this.cleanupDetailModel();
    this.cleanupGallery();
    this.disposeMRGroundPlanes();

    if (this.splatViewer) {
      const sortedIndexes = Array.from(this.activeSplatSceneIndexes).sort((a, b) => b - a);
      for (const sceneIndex of sortedIndexes) {
        try {
          await Promise.resolve(this.splatViewer.removeSplatScene(sceneIndex, false));
        } catch (error) {
          console.warn('[XR] removeSplatScene failed during teardown:', sceneIndex, error);
        }
      }

      this.activeSplatSceneIndexes.clear();

      if (this.vrScene && this.splatViewer.splatMesh && this.vrScene.children.includes(this.splatViewer.splatMesh)) {
        this.vrScene.remove(this.splatViewer.splatMesh);
      }

      try {
        await this.splatViewer.dispose();
      } catch (error) {
        console.warn('[XR] splat viewer dispose failed:', error);
      }

      this.splatViewer = null;
    }

    if (this.vrScene) {
      this.vrScene.clear();
    }

    this.vrScene = null;
    this.vrCamera = null;

    this.scene = this.externalScene;
    this.camera = this.externalCamera;

    this.restoreNormalModeState();

    this.currentState = STATE.GALLERY;
    this.renderer.setClearAlpha(1);
    this.renderer.renderLists?.dispose?.();

    console.log(`[XR] session ended from ${previousMode}`);
  }

  setupXRLighting() {
    if (!this.vrScene) {
      return;
    }

    const ambient = new THREE.AmbientLight(0xffffff, this.isMRMode ? 0.9 : 1.25);
    this.vrScene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, this.isMRMode ? 1.2 : 1.0);
    keyLight.position.set(2, 4, 3);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 0.1;
    keyLight.shadow.camera.far = 20;
    keyLight.shadow.bias = -0.0005;
    this.vrScene.add(keyLight);

    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-2, 2, -1);
    this.vrScene.add(fill);
  }

  createMRGroundPlanes() {
    if (!this.vrScene) {
      return;
    }

    // Ground-aligned shadow catcher at local-floor y=0.
    const shadowGeometry = new THREE.PlaneGeometry(60, 60);
    shadowGeometry.rotateX(-Math.PI / 2);

    const shadowMaterial = new THREE.ShadowMaterial({
      opacity: 0.35,
      transparent: true,
      depthWrite: false
    });

    shadowMaterial.polygonOffset = true;
    shadowMaterial.polygonOffsetFactor = 1;
    shadowMaterial.polygonOffsetUnits = 1;

    this.shadowCatcher = new THREE.Mesh(shadowGeometry, shadowMaterial);
    this.shadowCatcher.position.set(0, 0, 0);
    this.shadowCatcher.receiveShadow = true;
    this.shadowCatcher.renderOrder = -2;

    // Invisible depth occluder for virtual-real clipping on the same y=0 plane.
    const occlusionGeometry = new THREE.PlaneGeometry(60, 60);
    occlusionGeometry.rotateX(-Math.PI / 2);

    const occlusionMaterial = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: true,
      depthTest: true
    });

    this.occlusionPlane = new THREE.Mesh(occlusionGeometry, occlusionMaterial);
    this.occlusionPlane.position.set(0, 0, 0);
    this.occlusionPlane.renderOrder = -3;

    this.vrScene.add(this.occlusionPlane);
    this.vrScene.add(this.shadowCatcher);
  }

  disposeMRGroundPlanes() {
    const disposeMesh = (mesh) => {
      if (!mesh) {
        return;
      }

      if (mesh.parent) {
        mesh.parent.remove(mesh);
      }

      mesh.geometry?.dispose?.();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((mat) => mat.dispose?.());
      } else {
        mesh.material?.dispose?.();
      }
    };

    disposeMesh(this.shadowCatcher);
    disposeMesh(this.occlusionPlane);

    this.shadowCatcher = null;
    this.occlusionPlane = null;
  }

  async initSplatViewer() {
    try {
      if (!this.GaussianSplats3D) {
        this.GaussianSplats3D = await import('@mkkellogg/gaussian-splats-3d');
      }

      if (this.splatViewer) {
        try {
          await this.splatViewer.dispose();
        } catch (error) {
          console.warn('[XR] previous splat viewer dispose failed:', error);
        }
      }

      const webXRMode = this.isMRMode
        ? this.GaussianSplats3D.WebXRMode.AR
        : this.GaussianSplats3D.WebXRMode.VR;

      this.splatViewer = new this.GaussianSplats3D.Viewer({
        selfDrivenMode: false,
        renderer: this.renderer,
        camera: this.vrCamera,
        threeScene: this.vrScene,
        useBuiltInControls: false,
        webXRMode,
        renderMode: this.GaussianSplats3D.RenderMode.Always,
        dynamicScene: true,
        gpuAcceleratedSort: true,
        sharedMemoryForWorkers: true,
        sceneRevealMode: this.GaussianSplats3D.SceneRevealMode.Instant
      });

      return true;
    } catch (error) {
      console.error('[XR] initSplatViewer failed:', error);
      this.splatViewer = null;
      return false;
    }
  }

  ensureSplatMeshAttached() {
    if (!this.splatViewer || !this.vrScene) {
      return;
    }

    if (this.splatViewer.splatMesh && !this.vrScene.children.includes(this.splatViewer.splatMesh)) {
      this.vrScene.add(this.splatViewer.splatMesh);
    }
  }

  setupSessionInputHandling() {
    if (!this.vrSession || !this.vrScene) {
      return;
    }

    this.vrSession.addEventListener('select', this.onSessionSelectBound);
    this.vrSession.addEventListener('selectstart', this.onSessionSelectStartBound);
    this.vrSession.addEventListener('selectend', this.onSessionSelectEndBound);
    this.vrSession.addEventListener('inputsourceschange', this.onInputSourcesChangeBound);

    this.controller0 = this.renderer.xr.getController(0);
    this.controller1 = this.renderer.xr.getController(1);

    if (this.controller0) {
      this.vrScene.add(this.controller0);
      this.buildControllerVisual(this.controller0);
    }

    if (this.controller1) {
      this.vrScene.add(this.controller1);
      this.buildControllerVisual(this.controller1);
    }
  }

  removeSessionInputHandling() {
    if (this.vrSession) {
      this.vrSession.removeEventListener('select', this.onSessionSelectBound);
      this.vrSession.removeEventListener('selectstart', this.onSessionSelectStartBound);
      this.vrSession.removeEventListener('selectend', this.onSessionSelectEndBound);
      this.vrSession.removeEventListener('inputsourceschange', this.onInputSourcesChangeBound);
    }

    if (this.controller0?.parent) {
      this.controller0.parent.remove(this.controller0);
    }

    if (this.controller1?.parent) {
      this.controller1.parent.remove(this.controller1);
    }

    this.controller0 = null;
    this.controller1 = null;
  }

  buildControllerVisual(controller) {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -1.5)
    ]);

    const material = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.4
    });

    const line = new THREE.Line(geometry, material);
    controller.add(line);
  }

  async fetchModelsData() {
    try {
      const response = await fetch('/api/models', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const models = await response.json();

      this.modelsData = models.map((model, index) => ({
        name: model.name || `Model ${index + 1}`,
        path: model.path,
        type: this.getModelType(model.format),
        color: this.getColorByIndex(index)
      }));

      await this.createGallery(this.modelsData);
    } catch (error) {
      console.error('[XR] fetchModelsData failed:', error);
      this.modelsData = [];
    }
  }

  getModelType(format) {
    const lower = (format || '').toLowerCase();
    if (lower === 'ply' || lower === 'splat' || lower === 'ksplat' || lower === 'spz') {
      return 'splat';
    }

    return 'glb';
  }

  getColorByIndex(index) {
    const colors = [0xff6b6b, 0x4ecdc4, 0x95e1d3, 0xf38181, 0xaa96da, 0xfcbad3];
    return colors[index % colors.length];
  }

  async createGallery(modelsData) {
    this.cleanupGallery();

    if (!this.vrScene) {
      return;
    }

    this.galleryGroup = new THREE.Group();
    this.galleryGroup.name = 'GalleryGroup';

    const count = modelsData.length;
    const startAngle = -Math.PI / 3;
    const endAngle = Math.PI / 3;

    for (let i = 0; i < count; i += 1) {
      const data = modelsData[i];
      const angle = startAngle + (endAngle - startAngle) * (i / Math.max(1, count - 1));
      const x = Math.sin(angle) * GALLERY_RADIUS;
      const z = -Math.cos(angle) * GALLERY_RADIUS;
      const position = new THREE.Vector3(x, GALLERY_HEIGHT, z);

      await this.loadGalleryModel(data, position, i);
    }

    this.vrScene.add(this.galleryGroup);
  }

  async loadGalleryModel(data, position, index) {
    try {
      if (data.type === 'glb') {
        const gltf = await this.loadGLTF(data.path);
        const model = gltf.scene;

        this.normalizeModelScale(model, GALLERY_SCALE);
        model.position.copy(position);

        const faceDirection = new THREE.Vector3(0, GALLERY_HEIGHT, 0).sub(position).normalize();
        model.rotation.y = Math.atan2(faceDirection.x, faceDirection.z);

        model.traverse((obj) => {
          if (obj.isMesh) {
            obj.castShadow = true;
            obj.receiveShadow = true;
          }
        });

        this.galleryGroup.add(model);

        const hitBox = this.createHitBoxForObject(model);
        hitBox.userData.modelData = data;
        hitBox.userData.index = index;

        this.galleryGroup.add(hitBox);
        this.hitBoxes.push(hitBox);

        this.galleryItems.push({
          type: 'glb',
          data,
          index,
          model,
          hitBox,
          splatIndex: null,
          originalScale: model.scale.clone()
        });

        return;
      }

      if (data.type === 'splat') {
        if (!this.splatViewer) {
          this.createErrorBox(position, data, index);
          return;
        }

        const sceneCountBefore = this.splatViewer.getSceneCount();

        await this.splatViewer.addSplatScene(data.path, {
          position: [position.x, position.y, position.z],
          scale: [GALLERY_SCALE, GALLERY_SCALE, GALLERY_SCALE],
          rotation: [0, 0, 0, 1],
          progressiveLoad: false,
          showLoadingUI: false
        });

        this.ensureSplatMeshAttached();

        const splatIndex = sceneCountBefore;
        this.activeSplatSceneIndexes.add(splatIndex);

        const splatBox = this.estimateSplatBoundingBox(splatIndex, position, GALLERY_SCALE);
        const hitBox = this.createHitBoxFromBox(splatBox, position, MIN_PROXY_SIZE, 1.1);

        hitBox.userData.modelData = data;
        hitBox.userData.index = index;
        hitBox.userData.splatIndex = splatIndex;

        this.galleryGroup.add(hitBox);
        this.hitBoxes.push(hitBox);

        const sceneTransform = this.getSplatSceneTransform(splatIndex);

        this.galleryItems.push({
          type: 'splat',
          data,
          index,
          model: null,
          hitBox,
          splatIndex,
          originalScale: sceneTransform.scale.clone(),
          originalPosition: sceneTransform.position.clone(),
          originalQuaternion: sceneTransform.quaternion.clone()
        });

        return;
      }

      this.createErrorBox(position, data, index);
    } catch (error) {
      console.error(`[XR] loadGalleryModel failed at index ${index}:`, error);
      this.createErrorBox(position, data, index);
    }
  }

  createHitBoxForObject(object3D) {
    object3D.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object3D);
    const fallback = object3D.position.clone();
    return this.createHitBoxFromBox(box, fallback, MIN_PROXY_SIZE, 1.1);
  }

  createHitBoxFromBox(box, fallbackPosition, minSize = MIN_PROXY_SIZE, expandFactor = 1.05) {
    const size = new THREE.Vector3(minSize, minSize, minSize);
    const center = fallbackPosition ? fallbackPosition.clone() : new THREE.Vector3();

    if (box && !box.isEmpty()) {
      box.getSize(size);
      size.multiplyScalar(expandFactor);
      box.getCenter(center);
    }

    size.x = Math.max(minSize, size.x);
    size.y = Math.max(minSize, size.y);
    size.z = Math.max(minSize, size.z);

    const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    const material = new THREE.MeshBasicMaterial({
      color: 0x00ffaa,
      transparent: true,
      opacity: 0.0,
      depthWrite: false
    });

    const hitBox = new THREE.Mesh(geometry, material);
    hitBox.position.copy(center);
    hitBox.userData.isHitBox = true;

    return hitBox;
  }

  estimateSplatBoundingBox(sceneIndex, fallbackPosition, fallbackScale) {
    const splatMesh = this.getSplatMesh();
    if (splatMesh && typeof splatMesh.computeBoundingBox === 'function') {
      try {
        const box = splatMesh.computeBoundingBox(true, sceneIndex);
        if (box && !box.isEmpty()) {
          return box.clone();
        }
      } catch (error) {
        console.warn('[XR] computeBoundingBox failed for splat scene:', sceneIndex, error);
      }
    }

    const fallbackExtent = Math.max(0.45, fallbackScale * 1.2);
    return new THREE.Box3(
      new THREE.Vector3(
        fallbackPosition.x - fallbackExtent,
        fallbackPosition.y - fallbackExtent,
        fallbackPosition.z - fallbackExtent
      ),
      new THREE.Vector3(
        fallbackPosition.x + fallbackExtent,
        fallbackPosition.y + fallbackExtent,
        fallbackPosition.z + fallbackExtent
      )
    );
  }

  getSplatMesh() {
    if (!this.splatViewer) {
      return null;
    }

    if (typeof this.splatViewer.getSplatMesh === 'function') {
      return this.splatViewer.getSplatMesh();
    }

    return this.splatViewer.splatMesh || null;
  }

  getSplatScene(sceneIndex) {
    if (!this.splatViewer || sceneIndex === null || sceneIndex === undefined) {
      return null;
    }

    if (typeof this.splatViewer.getSplatScene === 'function') {
      try {
        return this.splatViewer.getSplatScene(sceneIndex);
      } catch (error) {
        console.warn('[XR] getSplatScene failed:', sceneIndex, error);
      }
    }

    return null;
  }

  getSplatSceneTransform(sceneIndex) {
    const scene = this.getSplatScene(sceneIndex);

    if (!scene) {
      return {
        position: new THREE.Vector3(),
        quaternion: new THREE.Quaternion(),
        scale: new THREE.Vector3(1, 1, 1)
      };
    }

    return {
      position: scene.position.clone(),
      quaternion: scene.quaternion.clone(),
      scale: scene.scale.clone()
    };
  }

  setSplatSceneTransform(sceneIndex, position, quaternion, scale) {
    const scene = this.getSplatScene(sceneIndex);
    if (!scene) {
      return;
    }

    scene.position.copy(position);
    scene.quaternion.copy(quaternion);
    scene.scale.copy(scale);

    scene.updateMatrix();
    scene.updateWorldMatrix(true, false);

    this.updateSplatTransforms();
  }

  updateSplatTransforms() {
    const splatMesh = this.getSplatMesh();
    if (splatMesh && typeof splatMesh.updateTransforms === 'function') {
      splatMesh.updateTransforms();
    }
  }

  createErrorBox(position, data, index) {
    if (!this.galleryGroup) {
      return;
    }

    const geometry = new THREE.BoxGeometry(0.4, 0.4, 0.4);
    const material = new THREE.MeshStandardMaterial({
      color: 0xff3b3b,
      emissive: 0x660000,
      emissiveIntensity: 0.6
    });

    const errorBox = new THREE.Mesh(geometry, material);
    errorBox.position.copy(position);

    this.galleryGroup.add(errorBox);

    const hitBox = this.createHitBoxForObject(errorBox);
    hitBox.userData.modelData = data;
    hitBox.userData.index = index;

    this.galleryGroup.add(hitBox);

    this.hitBoxes.push(hitBox);
    this.galleryItems.push({
      type: 'error',
      data,
      index,
      model: errorBox,
      hitBox,
      splatIndex: null,
      originalScale: errorBox.scale.clone()
    });
  }

  updateGalleryHover() {
    if (this.currentState !== STATE.GALLERY || this.hitBoxes.length === 0 || !this.isVRMode) {
      return;
    }

    const xrCamera = this.renderer.xr.getCamera(this.vrCamera || this.camera);
    if (!xrCamera) {
      return;
    }

    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), xrCamera);
    const intersects = this.raycaster.intersectObjects(this.hitBoxes, false);

    const nextItem = intersects.length > 0
      ? this.galleryItems.find((item) => item.hitBox === intersects[0].object) || null
      : null;

    if (this.hoveredItem && this.hoveredItem !== nextItem) {
      this.applyGalleryHover(this.hoveredItem, false);
    }

    if (nextItem && this.hoveredItem !== nextItem) {
      this.applyGalleryHover(nextItem, true);
    }

    this.hoveredItem = nextItem;
  }

  applyGalleryHover(item, hovered) {
    if (!item || !item.hitBox || !item.hitBox.material) {
      return;
    }

    item.hitBox.material.opacity = hovered ? 0.12 : 0.0;

    if (item.type === 'glb' && item.model) {
      if (hovered) {
        item.model.scale.copy(item.originalScale).multiplyScalar(1.12);
      } else {
        item.model.scale.copy(item.originalScale);
      }
    }
  }

  async enterDetailMode(modelData) {
    if (!modelData || this.currentState === STATE.DETAIL) {
      return;
    }

    this.currentState = STATE.DETAIL;

    if (this.galleryGroup) {
      this.galleryGroup.visible = false;
    }

    await this.loadDetailModel(modelData.path, modelData.type);
    this.createBackButton();
    this.createInfoPanel(modelData);
  }

  async loadDetailModel(path, type) {
    this.cleanupDetailModel();

    try {
      if (type === 'glb') {
        const gltf = await this.loadGLTF(path);
        const model = gltf.scene;

        this.normalizeModelScale(model, 1.5);
        model.position.copy(DETAIL_ANCHOR);
        model.rotation.y = Math.PI;

        model.traverse((obj) => {
          if (obj.isMesh) {
            obj.castShadow = true;
            obj.receiveShadow = true;
          }
        });

        this.detailModel = model;
        this.detailModelType = 'glb';

        this.vrScene.add(this.detailModel);
        return;
      }

      if (type === 'splat') {
        if (!this.splatViewer) {
          throw new Error('Splat viewer is not initialized');
        }

        const sceneCountBefore = this.splatViewer.getSceneCount();

        await this.splatViewer.addSplatScene(path, {
          position: [DETAIL_ANCHOR.x, DETAIL_ANCHOR.y, DETAIL_ANCHOR.z],
          scale: [1.5, 1.5, 1.5],
          rotation: [0, 0, 0, 1],
          progressiveLoad: false,
          showLoadingUI: false
        });

        this.ensureSplatMeshAttached();

        this.detailSplatIndex = sceneCountBefore;
        this.activeSplatSceneIndexes.add(this.detailSplatIndex);

        const detailBox = this.estimateSplatBoundingBox(this.detailSplatIndex, DETAIL_ANCHOR, 1.5);
        const detailProxy = this.createHitBoxFromBox(detailBox, DETAIL_ANCHOR, 0.25, 1.05);

        // Proxy must stay raycastable while visually hidden.
        detailProxy.material.opacity = 0.0;

        this.detailModel = detailProxy;
        this.detailModelType = 'splat';

        this.vrScene.add(this.detailModel);
        return;
      }

      this.createDetailErrorBox();
    } catch (error) {
      console.error('[XR] loadDetailModel failed:', error);
      this.createDetailErrorBox();
    }
  }

  createDetailErrorBox() {
    const geometry = new THREE.BoxGeometry(0.8, 0.8, 0.8);
    const material = new THREE.MeshStandardMaterial({
      color: 0xff3b3b,
      emissive: 0x660000,
      emissiveIntensity: 0.6
    });

    this.detailModel = new THREE.Mesh(geometry, material);
    this.detailModel.position.copy(DETAIL_ANCHOR);
    this.detailModelType = 'error';

    this.vrScene.add(this.detailModel);
  }

  cleanupDetailModel() {
    this.clearInteractionState();

    if (this.detailModel) {
      if (this.detailModel.parent) {
        this.detailModel.parent.remove(this.detailModel);
      }

      this.disposeSceneObject(this.detailModel);
      this.detailModel = null;
    }

    if (this.detailModelType === 'splat' && this.splatViewer && this.detailSplatIndex !== null) {
      try {
        this.splatViewer.removeSplatScene(this.detailSplatIndex, false);
      } catch (error) {
        console.warn('[XR] remove detail splat scene failed:', error);
      }

      this.activeSplatSceneIndexes.delete(this.detailSplatIndex);
      this.detailSplatIndex = null;
    }

    this.detailModelType = null;

    this.removeBackButton();
    this.removeInfoPanel();
  }

  createBackButton() {
    this.removeBackButton();

    const geometry = new THREE.CircleGeometry(0.22, 32);
    const material = new THREE.MeshBasicMaterial({
      color: 0xff6b6b,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide
    });

    const button = new THREE.Mesh(geometry, material);
    button.position.set(-1.25, 1.8, -2.0);
    button.lookAt(0, 1.8, 0);

    const arrowGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0.06, 0.0, 0.01),
      new THREE.Vector3(-0.06, 0.0, 0.01),
      new THREE.Vector3(-0.02, 0.06, 0.01),
      new THREE.Vector3(-0.06, 0.0, 0.01),
      new THREE.Vector3(-0.02, -0.06, 0.01)
    ]);

    const arrowMaterial = new THREE.LineBasicMaterial({ color: 0xffffff });
    const arrow = new THREE.Line(arrowGeometry, arrowMaterial);

    button.add(arrow);

    this.backButton = button;
    this.vrScene.add(this.backButton);
  }

  removeBackButton() {
    if (!this.backButton) {
      return;
    }

    if (this.backButton.parent) {
      this.backButton.parent.remove(this.backButton);
    }

    this.disposeSceneObject(this.backButton);
    this.backButton = null;
  }

  createInfoPanel(modelData) {
    this.removeInfoPanel();

    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 300;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 56px -apple-system, Segoe UI, sans-serif';
    ctx.fillText(modelData.name || 'Unnamed Model', 40, 90);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
    ctx.font = '32px -apple-system, Segoe UI, sans-serif';
    ctx.fillText(`Type: ${(modelData.type || 'unknown').toUpperCase()}`, 40, 155);
    ctx.fillText('Pinch once: select/back   Pinch + move: translate   Two-hand pinch: scale/rotate', 40, 220);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false
    });

    const geometry = new THREE.PlaneGeometry(1.8, 0.53);
    const panel = new THREE.Mesh(geometry, material);
    panel.position.set(0, 0.72, -1.35);

    this.infoPanel = panel;
    this.vrScene.add(this.infoPanel);
  }

  removeInfoPanel() {
    if (!this.infoPanel) {
      return;
    }

    if (this.infoPanel.parent) {
      this.infoPanel.parent.remove(this.infoPanel);
    }

    this.disposeSceneObject(this.infoPanel);
    this.infoPanel = null;
  }

  exitDetailMode() {
    if (this.currentState !== STATE.DETAIL) {
      return;
    }

    this.cleanupDetailModel();

    if (this.galleryGroup) {
      this.galleryGroup.visible = true;
    }

    this.currentState = STATE.GALLERY;
  }

  onInputSourcesChange() {
    // AVP can recycle transient pointers rapidly. Reset one-hand matrix cache to avoid stale deltas.
    this.lastGripMatrices.clear();
  }

  onSessionSelect(event) {
    if (!this.isVRMode || !event || !event.inputSource) {
      return;
    }

    const inputSource = event.inputSource;
    if (inputSource.targetRayMode !== 'transient-pointer') {
      return;
    }

    const ray = this.buildRayFromInputSource(event);
    if (!ray) {
      return;
    }

    this.raycaster.set(ray.origin, ray.direction);

    if (this.currentState === STATE.GALLERY) {
      const intersects = this.raycaster.intersectObjects(this.hitBoxes, false);
      if (intersects.length > 0) {
        const hitBox = intersects[0].object;
        const modelData = hitBox.userData.modelData;
        if (modelData) {
          void this.enterDetailMode(modelData);
        }
      }
      return;
    }

    if (this.currentState === STATE.DETAIL && this.backButton) {
      const backHits = this.raycaster.intersectObject(this.backButton, true);
      if (backHits.length > 0) {
        this.exitDetailMode();
      }
    }
  }

  buildRayFromInputSource(event) {
    const frame = event.frame;
    const inputSource = event.inputSource;
    const referenceSpace = this.renderer.xr.getReferenceSpace();

    if (frame && referenceSpace && inputSource.targetRaySpace) {
      const targetRayPose = frame.getPose(inputSource.targetRaySpace, referenceSpace);
      if (targetRayPose?.transform?.matrix && this.isValidPoseMatrix(targetRayPose.transform.matrix)) {
        try {
          const matrix = new THREE.Matrix4().fromArray(targetRayPose.transform.matrix);
          const origin = new THREE.Vector3().setFromMatrixPosition(matrix);
          const direction = new THREE.Vector3(0, 0, -1)
            .transformDirection(matrix)
            .normalize();

          if (Number.isFinite(direction.x) && Number.isFinite(direction.y) && Number.isFinite(direction.z)) {
            return { origin, direction };
          }
        } catch (error) {
          console.warn('[XR] targetRayPose extraction failed, falling back to camera ray:', error);
        }
      }
    }

    // Mandatory AVP fallback: when targetRayPose is unavailable or invalid, use XR camera forward ray.
    const xrCamera = this.renderer.xr.getCamera(this.vrCamera || this.camera);
    if (!xrCamera) {
      return null;
    }

    const origin = new THREE.Vector3();
    const direction = new THREE.Vector3();
    xrCamera.getWorldPosition(origin);
    xrCamera.getWorldDirection(direction);

    if (!Number.isFinite(direction.x) || !Number.isFinite(direction.y) || !Number.isFinite(direction.z)) {
      return null;
    }

    return { origin, direction: direction.normalize() };
  }

  isValidPoseMatrix(matrixArray) {
    if (!matrixArray || matrixArray.length !== 16) {
      return false;
    }

    for (let i = 0; i < 16; i += 1) {
      const value = matrixArray[i];
      if (!Number.isFinite(value)) {
        return false;
      }
    }

    return true;
  }

  onSessionSelectStart(event) {
    if (event?.inputSource?.targetRayMode !== 'transient-pointer') {
      return;
    }

    // No-op by design: AVP can report handedness="none" for both hands.
    // We derive interaction state from transient pointer count and grip matrices each frame.
  }

  onSessionSelectEnd(event) {
    if (event?.inputSource?.targetRayMode !== 'transient-pointer') {
      return;
    }

    // Cleanup is frame-driven; this handler is intentionally minimal.
  }

  updateTwoHandInteraction() {
    if (this.currentState !== STATE.DETAIL || !this.detailModel || !this.vrSession) {
      return;
    }

    const frame = this.renderer.xr.getFrame();
    const referenceSpace = this.renderer.xr.getReferenceSpace();
    if (!frame || !referenceSpace) {
      return;
    }

    const pointers = this.collectTransientPointersWithGrip(frame, referenceSpace);
    if (pointers.length !== 2) {
      if (this.initialPinchDistance > 0) {
        this.initialPinchDistance = 0;
        this.initialModelScale = null;
        this.lastRotationAngle = null;
      }
      return;
    }

    const p0 = pointers[0].position;
    const p1 = pointers[1].position;

    const currentDistance = p0.distanceTo(p1);
    if (currentDistance <= 0) {
      return;
    }

    if (this.initialPinchDistance === 0) {
      this.initialPinchDistance = currentDistance;
      this.initialModelScale = this.detailModel.scale.x;
      this.lastRotationAngle = Math.atan2(p1.z - p0.z, p1.x - p0.x);
      return;
    }

    const scaleRatio = currentDistance / this.initialPinchDistance;
    const targetScale = (this.initialModelScale || 1) * scaleRatio;
    const clampedScale = THREE.MathUtils.clamp(targetScale, MIN_MODEL_SCALE, MAX_MODEL_SCALE);
    this.detailModel.scale.setScalar(clampedScale);

    const currentAngle = Math.atan2(p1.z - p0.z, p1.x - p0.x);
    if (this.lastRotationAngle !== null) {
      const deltaAngle = currentAngle - this.lastRotationAngle;
      this.detailModel.rotation.y += deltaAngle;
    }
    this.lastRotationAngle = currentAngle;

    this.syncSplatModelFromProxy();
  }

  updateOneHandInteraction() {
    if (this.currentState !== STATE.DETAIL || !this.detailModel || !this.vrSession) {
      return;
    }

    const frame = this.renderer.xr.getFrame();
    const referenceSpace = this.renderer.xr.getReferenceSpace();
    if (!frame || !referenceSpace) {
      return;
    }

    const pointers = this.collectTransientPointersWithGrip(frame, referenceSpace);

    if (pointers.length !== 1) {
      this.lastGripMatrices.clear();
      return;
    }

    const currentMatrix = pointers[0].gripMatrix;
    const prevMatrix = this.lastGripMatrices.get('transient_0');

    if (prevMatrix) {
      // Mandatory AVP translation strategy:
      // use matrix delta between consecutive gripSpace transforms,
      // not direct position subtraction, to stay stable under parent transforms.
      const deltaMatrix = new THREE.Matrix4().copy(currentMatrix).multiply(prevMatrix.clone().invert());
      this.detailModel.applyMatrix4(deltaMatrix);
      this.syncSplatModelFromProxy();
    }

    this.lastGripMatrices.set('transient_0', currentMatrix.clone());
  }

  collectTransientPointersWithGrip(frame, referenceSpace) {
    const pointers = [];

    for (const inputSource of this.vrSession.inputSources) {
      if (inputSource.targetRayMode !== 'transient-pointer' || !inputSource.gripSpace) {
        continue;
      }

      const gripPose = frame.getPose(inputSource.gripSpace, referenceSpace);
      if (!gripPose?.transform?.matrix || !this.isValidPoseMatrix(gripPose.transform.matrix)) {
        continue;
      }

      const gripMatrix = new THREE.Matrix4().fromArray(gripPose.transform.matrix);
      const position = new THREE.Vector3().setFromMatrixPosition(gripMatrix);

      pointers.push({
        inputSource,
        gripMatrix,
        position
      });
    }

    return pointers;
  }

  syncSplatModelFromProxy() {
    if (this.detailModelType !== 'splat' || !this.splatViewer || this.detailSplatIndex === null || !this.detailModel) {
      return;
    }

    this.detailModel.updateMatrixWorld(true);

    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    this.detailModel.matrix.decompose(position, quaternion, scale);
    this.setSplatSceneTransform(this.detailSplatIndex, position, quaternion, scale);
  }

  clearInteractionState() {
    this.lastGripMatrices.clear();
    this.initialPinchDistance = 0;
    this.initialModelScale = null;
    this.lastRotationAngle = null;
  }

  normalizeModelScale(object3D, targetHeightMeters) {
    if (!object3D) {
      return;
    }

    object3D.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(object3D);
    const size = new THREE.Vector3();
    box.getSize(size);

    const currentHeight = size.y;
    if (!Number.isFinite(currentHeight) || currentHeight < 1e-4) {
      return;
    }

    const scaleFactor = targetHeightMeters / currentHeight;
    object3D.scale.multiplyScalar(scaleFactor);
    object3D.updateMatrixWorld(true);
  }

  loadGLTF(path) {
    return new Promise((resolve, reject) => {
      const loader = new GLTFLoader();
      const dracoLoader = new DRACOLoader();

      // Use local decoder assets to avoid COOP/COEP + CDN fetch failures.
      dracoLoader.setDecoderPath('/node_modules/three/examples/jsm/libs/draco/gltf/');
      loader.setDRACOLoader(dracoLoader);

      loader.load(
        path,
        (gltf) => {
          resolve(gltf);
          dracoLoader.dispose?.();
        },
        undefined,
        (error) => {
          reject(error);
          dracoLoader.dispose?.();
        }
      );
    });
  }

  saveNormalModeState() {
    this.savedBackground = this.externalScene.background;
    this.savedClearAlpha = this.renderer.getClearAlpha();

    if (window.controls) {
      window.controls.enabled = false;
    }
  }

  restoreNormalModeState() {
    this.externalScene.background = this.savedBackground;
    this.renderer.setClearAlpha(this.savedClearAlpha ?? 1);

    if (window.controls) {
      window.controls.enabled = true;
    }
  }

  cleanupGallery() {
    if (!this.galleryGroup) {
      this.galleryItems = [];
      this.hitBoxes = [];
      this.hoveredItem = null;
      return;
    }

    if (this.galleryGroup.parent) {
      this.galleryGroup.parent.remove(this.galleryGroup);
    }

    for (const item of this.galleryItems) {
      if (item.model) {
        this.disposeSceneObject(item.model);
      }
      if (item.hitBox) {
        this.disposeSceneObject(item.hitBox);
      }
    }

    this.galleryGroup.clear();

    this.galleryGroup = null;
    this.galleryItems = [];
    this.hitBoxes = [];
    this.hoveredItem = null;
  }

  disposeSceneObject(object) {
    if (!object) {
      return;
    }

    object.traverse((child) => {
      if (child.geometry) {
        child.geometry.dispose();
      }

      if (child.material) {
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
          if (!material) {
            continue;
          }

          if (material.map) material.map.dispose();
          if (material.normalMap) material.normalMap.dispose();
          if (material.roughnessMap) material.roughnessMap.dispose();
          if (material.metalnessMap) material.metalnessMap.dispose();
          if (material.emissiveMap) material.emissiveMap.dispose();
          material.dispose();
        }
      }
    });
  }

  createUnsupportedDialog(id, title, message, gradient) {
    if (document.getElementById(id)) {
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = id;
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:rgba(0,0,0,0.68)',
      'backdrop-filter:blur(6px)',
      'z-index:10000'
    ].join(';');

    const panel = document.createElement('div');
    panel.style.cssText = [
      `background:${gradient}`,
      'border-radius:18px',
      'padding:28px',
      'width:min(88vw, 420px)',
      'box-shadow:0 14px 40px rgba(0,0,0,0.35)',
      'color:white',
      'text-align:center'
    ].join(';');

    const heading = document.createElement('h2');
    heading.textContent = title;
    heading.style.cssText = 'margin:0 0 12px;font-size:24px;line-height:1.3;';

    const body = document.createElement('p');
    body.textContent = message;
    body.style.cssText = 'margin:0 0 18px;font-size:15px;line-height:1.6;opacity:0.95;';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '我知道了';
    closeBtn.style.cssText = [
      'border:none',
      'background:rgba(255,255,255,0.2)',
      'color:white',
      'font-weight:600',
      'padding:10px 24px',
      'border-radius:10px',
      'cursor:pointer'
    ].join(';');

    closeBtn.onclick = () => overlay.remove();
    overlay.onclick = (event) => {
      if (event.target === overlay) {
        overlay.remove();
      }
    };

    panel.appendChild(heading);
    panel.appendChild(body);
    panel.appendChild(closeBtn);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  showVRNotSupportedDialog() {
    this.createUnsupportedDialog(
      'xr-vr-not-supported',
      '当前设备不支持 VR 模式',
      '请使用支持 WebXR immersive-vr 的设备或浏览器。',
      'linear-gradient(135deg, #4f46e5 0%, #312e81 100%)'
    );
  }

  showMRNotSupportedDialog() {
    this.createUnsupportedDialog(
      'xr-mr-not-supported',
      '当前设备不支持 MR 模式',
      '请使用支持 WebXR immersive-ar 的设备或浏览器。',
      'linear-gradient(135deg, #0f766e 0%, #115e59 100%)'
    );
  }

  update() {
    if (!this.isVRMode) {
      return;
    }

    if (this.currentState === STATE.GALLERY) {
      this.updateGalleryHover();
    }

    if (this.currentState === STATE.DETAIL) {
      this.updateTwoHandInteraction();
      this.updateOneHandInteraction();
    }

    // Keep Splat viewer under the shared XR render loop.
    // Do not call splatViewer.render() to avoid double-render flicker.
    if (this.splatViewer) {
      try {
        this.splatViewer.update();
      } catch (error) {
        if (Math.random() < 0.02) {
          console.warn('[XR] splatViewer.update failed:', error);
        }
      }
    }
  }

  async dispose() {
    try {
      await this.endActiveSession();
    } catch (error) {
      console.warn('[XR] dispose end session failed:', error);
    }

    this.renderer.xr.removeEventListener('sessionstart', this.rendererSessionStartBound);
    this.renderer.xr.removeEventListener('sessionend', this.rendererSessionEndBound);

    this.cleanupDetailModel();
    this.cleanupGallery();
    this.disposeMRGroundPlanes();

    if (this.splatViewer) {
      try {
        await this.splatViewer.dispose();
      } catch (error) {
        console.warn('[XR] splat viewer dispose failed:', error);
      }
      this.splatViewer = null;
    }

    this.activeSplatSceneIndexes.clear();
    this.clearInteractionState();
  }
}

export default VRModule;
