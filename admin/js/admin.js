// VisionPro 管理页面 JavaScript
// 全局变量
let models = [];
let backgrounds = [];
let currentFilter = 'all';

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init);

// 初始化函数
function init() {
    loadModelsList().then(() => {
        loadBackgroundsList();
    });
    
    // 添加事件监听
    document.getElementById('uploadBtn').addEventListener('click', uploadModel);
    document.getElementById('saveEditBtn').addEventListener('click', saveModelChanges);
    document.getElementById('confirmDeleteBtn').addEventListener('click', deleteModel);
    document.getElementById('confirmBatchDeleteBtn').addEventListener('click', batchDeleteModels);
    document.getElementById('searchBtn').addEventListener('click', searchModels);
    
    // 背景图事件监听
    document.getElementById('uploadBackgroundBtn').addEventListener('click', uploadBackground);
    document.getElementById('confirmDeleteBackgroundBtn').addEventListener('click', deleteBackground);
    //模态框打开监听
    const batchDeleteModal = document.getElementById('batchDeleteModal');
    if (batchDeleteModal) {
        batchDeleteModal.addEventListener('show.bs.modal', renderBatchDeleteOptions);
    }
    // 筛选事件
    const filterLinks = document.querySelectorAll('[data-filter]');
    filterLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            currentFilter = e.target.getAttribute('data-filter');
            filterModels();
        });
    });
}

// 加载模型列表
async function loadModelsList() {
    try {
        document.getElementById('modelList').innerHTML = `
            <div class="text-center py-4">
                <div class="spinner-border text-primary" role="status">
                    <span class="visually-hidden">正在加载...</span>
                </div>
                <p class="mt-2">正在从服务器加载模型数据...</p>
            </div>
        `;
        
        const response = await fetch('/api/models');
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        models = await response.json();
        renderModelList(models);
        renderBatchDeleteOptions();// 新增
        if (backgrounds.length > 0) {
            renderBackgroundList(backgrounds);
        }
    } catch (error) {
        console.error('加载模型列表失败:', error);
        document.getElementById('modelList').innerHTML = `
            <div class="text-center py-4">
                <i class="bi bi-exclamation-triangle text-warning" style="font-size: 3rem;"></i>
                <p class="mt-2">加载模型数据失败，请刷新页面或稍后重试。</p>
                <button class="btn btn-primary mt-2" onclick="loadModelsList()">
                    <i class="bi bi-arrow-clockwise"></i> 重试
                </button>
            </div>
        `;
    }
}

// 渲染模型列表
function renderModelList(modelList) {
    const container = document.getElementById('modelList');
    
    if (modelList.length === 0) {
        container.innerHTML = `
            <div class="text-center py-4">
                <i class="bi bi-inbox-fill" style="font-size: 3rem; color: #ccc;"></i>
                <p class="mt-2">暂无模型数据</p>
                <button class="btn btn-primary mt-2" data-bs-toggle="modal" data-bs-target="#uploadModal">
                    <i class="bi bi-plus-lg"></i> 添加第一个模型
                </button>
            </div>
        `;
        return;
    }
    
    let html = '';
    
    modelList.forEach((model, index) => {
        html += `
            <div class="row model-item text-center" data-id="${model.id}" data-format="${model.format}">
                <div class="col-1 d-flex align-items-center justify-content-center">${index + 1}</div>
                <div class="col-2 d-flex align-items-center justify-content-center">
                    <img src="${model.thumbnail}" alt="${model.name}" class="model-thumbnail">
                </div>
                <div class="col-2 d-flex align-items-center justify-content-center">${model.name}</div>
                <div class="col-3 d-flex align-items-center justify-content-center text-truncate">${model.description}</div>
                <div class="col-1 d-flex align-items-center justify-content-center">
                    <span class="model-format-badge format-${model.format.toLowerCase()}">${model.format.toUpperCase()}</span>
                </div>
                <div class="col-1 d-flex align-items-center justify-content-center order-controls">
                    <button class="btn btn-sm btn-outline-secondary btn-order" onclick="moveModelUp(${model.id})" ${index === 0 ? 'disabled' : ''}>
                        <i class="bi bi-arrow-up"></i>
                    </button>
                    <button class="btn btn-sm btn-outline-secondary btn-order" onclick="moveModelDown(${model.id})" ${index === modelList.length - 1 ? 'disabled' : ''}>
                        <i class="bi bi-arrow-down"></i>
                    </button>
                </div>
                <div class="col-2 d-flex align-items-center justify-content-center">
                    <div class="d-flex justify-content-center">
                        <button class="btn btn-sm btn-primary me-2" onclick="editModel(${model.id})">
                            <i class="bi bi-pencil"></i> 编辑
                        </button>
                        <button class="btn btn-sm btn-danger" onclick="confirmDelete(${model.id})">
                            <i class="bi bi-trash"></i> 删除
                        </button>
                    </div>
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

// 上传新模型
async function uploadModel() {
    const name = document.getElementById('modelName').value;
    const description = document.getElementById('modelDescription').value;
    const modelFile = document.getElementById('modelFile').files[0];
    const thumbnailFile = document.getElementById('thumbnailFile').files[0];
    const order = document.getElementById('modelOrder').value;
    
    if (!name || !modelFile || !thumbnailFile) {
        alert('请填写必填字段！');
        return;
    }
    
    try {
        const formData = new FormData();
        formData.append('name', name);
        formData.append('description', description);
        formData.append('order', order);
        formData.append('modelFile', modelFile);
        formData.append('thumbnailFile', thumbnailFile);
        
        showNotification('正在上传模型文件...', 'info');
        
        const response = await fetch('/api/models', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        await response.json();
        await loadModelsList();
        await loadBackgroundsList();
        
        const modalElement = document.getElementById('uploadModal');
        const modal = bootstrap.Modal.getInstance(modalElement);
        modal.hide();
        
        document.getElementById('uploadForm').reset();
        showNotification('模型上传成功！', 'success');
    } catch (error) {
        console.error('上传失败:', error);
        showNotification('模型上传失败，请重试！', 'danger');
    }
}

// 编辑模型
function editModel(id) {
    const model = models.find(m => m.id === id);
    if (!model) return;
    
    document.getElementById('editModelId').value = model.id;
    document.getElementById('editModelName').value = model.name;
    document.getElementById('editModelDescription').value = model.description;
    document.getElementById('editModelOrder').value = model.order;
    
    const modal = new bootstrap.Modal(document.getElementById('editModal'));
    modal.show();
}

// 保存模型修改
async function saveModelChanges() {
    const id = parseInt(document.getElementById('editModelId').value);
    const name = document.getElementById('editModelName').value;
    const description = document.getElementById('editModelDescription').value;
    const thumbnailFile = document.getElementById('editThumbnailFile').files[0];
    const order = parseInt(document.getElementById('editModelOrder').value);
    
    try {
        const formData = new FormData();
        formData.append('name', name);
        formData.append('description', description);
        formData.append('order', order);
        
        if (thumbnailFile) {
            formData.append('thumbnailFile', thumbnailFile);
        }
        
        showNotification('正在更新模型信息...', 'info');
        
        const response = await fetch(`/api/models/${id}`, {
            method: 'PUT',
            body: formData
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        await response.json();
        await loadModelsList();
        await loadBackgroundsList();
        
        const modalElement = document.getElementById('editModal');
        const modal = bootstrap.Modal.getInstance(modalElement);
        modal.hide();
        
        showNotification('模型更新成功！', 'success');
    } catch (error) {
        console.error('更新失败:', error);
        showNotification('模型更新失败，请重试！', 'danger');
    }
}

// 确认删除
function confirmDelete(id) {
    const model = models.find(m => m.id === id);
    if (!model) return;
    
    document.getElementById('deleteModelId').value = id;
    document.getElementById('deleteModelName').textContent = model.name;
    
    const modal = new bootstrap.Modal(document.getElementById('deleteModal'));
    modal.show();
}

// 删除模型
async function deleteModel() {
    const id = parseInt(document.getElementById('deleteModelId').value);
    
    try {
        showNotification('正在删除模型...', 'info');
        
        const response = await fetch(`/api/models/${id}`, {
            method: 'DELETE'
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        await response.json();
        await loadModelsList();
        
        const modalElement = document.getElementById('deleteModal');
        const modal = bootstrap.Modal.getInstance(modalElement);
        modal.hide();
        
        showNotification('模型已成功删除！', 'success');
    } catch (error) {
        console.error('删除失败:', error);
        showNotification('模型删除失败，请重试！', 'danger');
    }
}

// 上移模型
async function moveModelUp(id) {
    const index = models.findIndex(m => m.id === id);
    if (index <= 0) return;
    
    try {
        const response = await fetch('/api/models/reorder', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                modelId: id,
                newPosition: index - 1
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        await loadModelsList();
        showNotification('模型顺序已更新！', 'success');
    } catch (error) {
        console.error('更新顺序失败:', error);
        showNotification('更新模型顺序失败，请重试！', 'danger');
    }
}

// 下移模型
async function moveModelDown(id) {
    const index = models.findIndex(m => m.id === id);
    if (index === -1 || index >= models.length - 1) return;
    
    try {
        const response = await fetch('/api/models/reorder', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                modelId: id,
                newPosition: index + 1
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        await loadModelsList();
        showNotification('模型顺序已更新！', 'success');
    } catch (error) {
        console.error('更新顺序失败:', error);
        showNotification('更新模型顺序失败，请重试！', 'danger');
    }
}

// 搜索模型
function searchModels() {
    const searchTerm = document.getElementById('searchInput').value.trim().toLowerCase();
    
    if (!searchTerm) {
        renderModelList(models);
        return;
    }
    
    const filtered = models.filter(model => 
        model.name.toLowerCase().includes(searchTerm) || 
        model.description.toLowerCase().includes(searchTerm)
    );
    
    renderModelList(filtered);
}

// 筛选模型
function filterModels() {
    if (currentFilter === 'all') {
        renderModelList(models);
        return;
    }
    
    const filtered = models.filter(model => 
        model.format.toLowerCase() === currentFilter
    );
    
    renderModelList(filtered);
}

const SUPPORTED_FORMATS = ['glb', 'gltf', 'obj', 'stl', 'fbx', 'ply', 'splat', 'ksplat'];
//js动态生成复选框
function renderBatchDeleteOptions() {
  const container = document.getElementById('batchDeleteFormatList');
  if (!container) return;

  const formatCounts = {};
  models.forEach(model => {
    const fmt = model.format.toLowerCase();
    formatCounts[fmt] = (formatCounts[fmt] || 0) + 1;
  });

  let html = `
    <div class="form-check mb-2">
      <input class="form-check-input" type="checkbox" id="selectAllFormats" onchange="toggleAllFormats(this)">
      <label class="form-check-label fw-bold" for="selectAllFormats">
        全选 / 取消全选
      </label>
    </div>
  `;

  SUPPORTED_FORMATS.forEach(fmt => {
    const count = formatCounts[fmt] || 0;
    if (count > 0) {
      html += `
        <div class="form-check mb-2">
          <input class="form-check-input format-check" type="checkbox" name="deleteFormat" id="delete${fmt.toUpperCase()}" value="${fmt}">
          <label class="form-check-label" for="delete${fmt.toUpperCase()}">
            ${fmt.toUpperCase()} 格式 <span class="text-muted">(${count} 个模型)</span>
          </label>
        </div>
      `;
    }
  });

  container.innerHTML = html;
}

// 全选/取消全选
function toggleAllFormats(selectAllCheckbox) {
  const checkboxes = document.querySelectorAll('.format-check');
  checkboxes.forEach(cb => cb.checked = selectAllCheckbox.checked);
}

// 批量删除模型
// async function batchDeleteModels() {
//     const selectedFormat = document.querySelector('input[name="deleteFormat"]:checked').value;
    
//     try {
//         showNotification('正在批量删除模型...', 'info');
        
//         let modelsToDelete;
//         if (selectedFormat === 'all') {
//             modelsToDelete = [...models];
//         } else {
//             modelsToDelete = models.filter(model => 
//                 model.format.toLowerCase() === selectedFormat.toLowerCase()
//             );
//         }
        
//         if (modelsToDelete.length === 0) {
//             showNotification('没有找到符合条件的模型！', 'warning');
//             return;
//         }
        
//         const response = await fetch('/api/models/batch-delete', {
//             method: 'POST',
//             headers: {
//                 'Content-Type': 'application/json'
//             },
//             body: JSON.stringify({
//                 format: selectedFormat
//             })
//         });
        
//         if (!response.ok) {
//             throw new Error(`HTTP error! status: ${response.status}`);
//         }
        
//         const result = await response.json();
//         await loadModelsList();
        
//         const modalElement = document.getElementById('batchDeleteModal');
//         const modal = bootstrap.Modal.getInstance(modalElement);
//         modal.hide();
        
//         showNotification(`成功删除了 ${result.deletedCount || modelsToDelete.length} 个模型！`, 'success');
//     } catch (error) {
//         console.error('批量删除失败:', error);
//         showNotification('批量删除失败，请重试！', 'danger');
//     }
// }
async function batchDeleteModels() {
  // 获取所有选中的复选框值
  const checkedBoxes = document.querySelectorAll('.format-check:checked');
  const selectedFormats = Array.from(checkedBoxes).map(cb => cb.value);

  if (selectedFormats.length === 0) {
    showNotification('请至少选择一个格式！', 'warning');
    return;
  }

  // 二次确认
  const formatNames = selectedFormats.map(f => f.toUpperCase()).join('、');
  if (!confirm(`确定要删除以下格式的所有模型吗？\n${formatNames}\n此操作不可恢复！`)) {
    return;
  }

  showNotification('正在批量删除模型...', 'info');

  try {
    const response = await fetch('/api/models/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formats: selectedFormats })   // 发送数组
    });

    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    const result = await response.json();
    await loadModelsList();

    const modal = bootstrap.Modal.getInstance(document.getElementById('batchDeleteModal'));
    modal.hide();

    showNotification(`成功删除了 ${result.deletedCount || 0} 个模型！`, 'success');
  } catch (error) {
    console.error('批量删除失败:', error);
    showNotification('批量删除失败，请重试！', 'danger');
  }
}

// 显示通知
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `toast align-items-center text-white bg-${type} border-0`;
    notification.setAttribute('role', 'alert');
    notification.setAttribute('aria-live', 'assertive');
    notification.setAttribute('aria-atomic', 'true');
    
    notification.innerHTML = `
        <div class="d-flex">
            <div class="toast-body">
                ${message}
            </div>
            <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
        </div>
    `;
    
    let toastContainer = document.querySelector('.toast-container');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.className = 'toast-container position-fixed bottom-0 end-0 p-3';
        document.body.appendChild(toastContainer);
    }
    
    toastContainer.appendChild(notification);
    
    const toast = new bootstrap.Toast(notification);
    toast.show();
    
    notification.addEventListener('hidden.bs.toast', () => {
        notification.remove();
    });
}

// ========== 背景图管理功能 ==========

// 加载背景图列表
async function loadBackgroundsList() {
    try {
        document.getElementById('backgroundList').innerHTML = `
            <div class="text-center py-4">
                <div class="spinner-border text-primary" role="status">
                    <span class="visually-hidden">正在加载...</span>
                </div>
                <p class="mt-2">正在从服务器加载背景图数据...</p>
            </div>
        `;
        
        const response = await fetch('/api/backgrounds');
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        backgrounds = await response.json();
        if (models.length >= 0) {
            renderBackgroundList(backgrounds);
        }
    } catch (error) {
        console.error('加载背景图列表失败:', error);
        document.getElementById('backgroundList').innerHTML = `
            <div class="text-center py-4">
                <i class="bi bi-exclamation-triangle text-warning" style="font-size: 3rem;"></i>
                <p class="mt-2">加载背景图数据失败，请刷新页面或稍后重试。</p>
                <button class="btn btn-primary mt-2" onclick="loadBackgroundsList()">
                    <i class="bi bi-arrow-clockwise"></i> 重试
                </button>
            </div>
        `;
    }
}

// 渲染背景图列表
function renderBackgroundList(backgroundList) {
    const container = document.getElementById('backgroundList');
    
    if (backgroundList.length === 0) {
        container.innerHTML = `
            <div class="text-center py-4">
                <i class="bi bi-inbox-fill" style="font-size: 3rem; color: #ccc;"></i>
                <p class="mt-2">暂无背景图数据</p>
                <button class="btn btn-primary mt-2" data-bs-toggle="modal" data-bs-target="#uploadBackgroundModal">
                    <i class="bi bi-plus-lg"></i> 添加第一个背景图
                </button>
            </div>
        `;
        return;
    }
    
    let html = '';
    
    backgroundList.forEach((background, index) => {
        const usingModels = models.filter(m => m.backgroundId === background.id);
        const selectedModelNames = usingModels.map(m => m.name);
        
        html += `
            <div class="row background-item text-center" data-id="${background.id}">
                <div class="col-1 d-flex align-items-center justify-content-center">${index + 1}</div>
                <div class="col-2 d-flex align-items-center justify-content-center">
                    <img src="${background.path}" alt="${background.name}" class="model-thumbnail" style="width: 100px; height: 60px; object-fit: cover;">
                </div>
                <div class="col-7 d-flex align-items-center justify-content-center">
                    ${models.length > 0 ? `
                        <div style="width: 100%;">
                            <select class="form-select form-select-sm background-model-select" id="backgroundModelSelect-${background.id}" multiple size="1" onchange="updateModelBackgrounds(${background.id}); updateSelectedModelsDisplay(${background.id});" style="min-height: 38px;">
                                ${models.map(model => `
                                    <option value="${model.id}" ${model.backgroundId === background.id ? 'selected' : ''}>${model.name}</option>
                                `).join('')}
                            </select>
                            <div id="selectedModelsDisplay-${background.id}" class="mt-1" style="font-size: 0.85rem; color: #6c757d; text-align: left;">
                                ${selectedModelNames.length > 0 ? selectedModelNames.join('、') : '未选择任何模型'}
                            </div>
                        </div>
                    ` : `
                        <p class="text-muted mb-0">暂无模型，请先上传模型</p>
                    `}
                </div>
                <div class="col-2 d-flex align-items-center justify-content-center">
                    <button class="btn btn-sm btn-danger" onclick="confirmDeleteBackground(${background.id})">
                        <i class="bi bi-trash"></i> 删除
                    </button>
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

// 上传新背景图
async function uploadBackground() {
    const backgroundFile = document.getElementById('backgroundFile').files[0];
    
    if (!backgroundFile) {
        alert('请选择背景图文件！');
        return;
    }
    
    try {
        const formData = new FormData();
        const fileName = backgroundFile.name.replace(/\.[^/.]+$/, "");
        formData.append('name', fileName);
        formData.append('description', '');
        formData.append('order', backgrounds.length + 1);
        formData.append('backgroundFile', backgroundFile);
        
        showNotification('正在上传背景图文件...', 'info');
        
        const response = await fetch('/api/backgrounds', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        await response.json();
        await loadBackgroundsList();
        
        const modalElement = document.getElementById('uploadBackgroundModal');
        const modal = bootstrap.Modal.getInstance(modalElement);
        modal.hide();
        
        document.getElementById('uploadBackgroundForm').reset();
        showNotification('背景图上传成功！', 'success');
    } catch (error) {
        console.error('上传失败:', error);
        showNotification('背景图上传失败，请重试！', 'danger');
    }
}

// 更新选中模型的显示
function updateSelectedModelsDisplay(backgroundId) {
    const select = document.getElementById(`backgroundModelSelect-${backgroundId}`);
    const displayDiv = document.getElementById(`selectedModelsDisplay-${backgroundId}`);
    
    if (!select || !displayDiv) return;
    
    const selectedModelIds = Array.from(select.selectedOptions).map(option => parseInt(option.value));
    const selectedModelNames = models
        .filter(model => selectedModelIds.includes(model.id))
        .map(model => model.name);
    
    if (selectedModelNames.length > 0) {
        displayDiv.textContent = selectedModelNames.join('、');
    } else {
        displayDiv.textContent = '未选择任何模型';
    }
}

// 更新模型的背景图
async function updateModelBackgrounds(backgroundId) {
    const select = document.getElementById(`backgroundModelSelect-${backgroundId}`);
    if (!select) return;
    
    const selectedModelIds = Array.from(select.selectedOptions).map(option => parseInt(option.value));
    
    try {
        showNotification('正在更新模型背景图...', 'info');
        
        const updatePromises = models.map(async (model) => {
            const shouldHaveBackground = selectedModelIds.includes(model.id);
            const currentBackgroundId = model.backgroundId;
            
            if ((shouldHaveBackground && currentBackgroundId !== backgroundId) || 
                (!shouldHaveBackground && currentBackgroundId === backgroundId)) {
                
                const formData = new FormData();
                formData.append('name', model.name);
                formData.append('description', model.description || '');
                formData.append('order', model.order);
                formData.append('backgroundId', shouldHaveBackground ? backgroundId : '');
                
                const response = await fetch(`/api/models/${model.id}`, {
                    method: 'PUT',
                    body: formData
                });
                
                if (!response.ok) {
                    throw new Error(`更新模型 ${model.name} 失败`);
                }
                
                return await response.json();
            }
            return null;
        });
        
        await Promise.all(updatePromises);
        await loadModelsList();
        
        updateSelectedModelsDisplay(backgroundId);
        
        const selectedModelNames = models
            .filter(model => selectedModelIds.includes(model.id))
            .map(model => model.name);
        const displayText = selectedModelNames.length > 0 ? selectedModelNames.join('、') : '无';
        showNotification(`成功为以下模型设置了背景图：${displayText}`, 'success');
    } catch (error) {
        console.error('更新模型背景图失败:', error);
        showNotification('更新模型背景图失败，请重试！', 'danger');
        await loadBackgroundsList();
    }
}

// 确认删除背景图
function confirmDeleteBackground(id) {
    const background = backgrounds.find(b => b.id === id);
    if (!background) return;
    
    document.getElementById('deleteBackgroundId').value = id;
    document.getElementById('deleteBackgroundName').textContent = background.name || `背景图 #${id}`;
    
    const modal = new bootstrap.Modal(document.getElementById('deleteBackgroundModal'));
    modal.show();
}

// 删除背景图
async function deleteBackground() {
    const id = parseInt(document.getElementById('deleteBackgroundId').value);
    
    try {
        showNotification('正在删除背景图...', 'info');
        
        const response = await fetch(`/api/backgrounds/${id}`, {
            method: 'DELETE'
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        await response.json();
        await loadBackgroundsList();
        
        const modalElement = document.getElementById('deleteBackgroundModal');
        const modal = bootstrap.Modal.getInstance(modalElement);
        modal.hide();
        
        showNotification('背景图已成功删除！', 'success');
    } catch (error) {
        console.error('删除失败:', error);
        showNotification('背景图删除失败，请重试！', 'danger');
    }
}
