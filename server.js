const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const WebSocket = require('ws');
const { spawn } = require('child_process');

const app = express();
const port = process.env.PORT || 3001;

// ============================================================================
// 1. 部署与安全自检 (优先级最高)
// ============================================================================

const modelsDir = path.join(__dirname, 'models');
const dataDir = path.join(__dirname, 'data');
const imagesDir = path.join(__dirname, 'images');

function checkSystemRequirements() {
    console.log('🔍 正在执行启动安全自检...');

    // 1.1 依赖版本检查 (简化版，生产环境应更严格)
    try {
        const pkg = require('./package.json');
        if (!pkg.dependencies['three']) {
            console.warn('⚠️  警告: package.json 中缺少 three 依赖');
        }
        console.log('✓ 依赖检查通过');
    } catch (e) {
        console.error('✗ 无法读取 package.json');
        process.exit(1);
    }

    // 1.2 文件系统写入权限 (Crucial)
    try {
        // 确保存储目录存在
        [dataDir, modelsDir, imagesDir].forEach(dir => {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        });

        // 检查 models 目录是否有写入权限
        fs.accessSync(modelsDir, fs.constants.W_OK);
        console.log('✓ 文件系统权限检查通过 (models/ 可写)');
    } catch (error) {
        console.error('🛑 致命错误: Node.js 进程无权写入 models/ 目录！');
        console.error('   请检查文件系统权限或以管理员身份运行。');
        process.exit(1); // 立即停止，防止静默失败
    }

    // 1.3 HTTPS 环境预检 (提示性)
    if (process.env.NODE_ENV === 'production' && !process.env.HTTPS) {
        console.warn('⚠️  警告: WebXR 需要 HTTPS 上下文。请确保通过 HTTPS 反向代理访问。');
    }
}

checkSystemRequirements();

// ============================================================================
// 2. 自动化转换引擎 (Node.js) - PLY to KSPLAT
// ============================================================================

// 防抖动定时器 - 使用 Map 以支持并发控制
const conversionQueue = new Map(); // Map<filename, timestamp>
let conversionTimer = null;
let isProcessingQueue = false;

function triggerConversion() {
    if (conversionTimer) clearTimeout(conversionTimer);
    conversionTimer = setTimeout(() => {
        processConversionQueue();
    }, 1000);
}

async function processConversionQueue() {
    if (conversionQueue.size === 0 || isProcessingQueue) return;

    isProcessingQueue = true;
    
    try {
        const files = Array.from(conversionQueue.keys());
        conversionQueue.clear();

        for (const filename of files) {
            await convertPlyToKsplat(filename);
        }
    } catch (error) {
        console.error('处理转换队列时出错:', error);
    } finally {
        isProcessingQueue = false;
    }
}

async function convertPlyToKsplat(filename) {
    const plyPath = path.join(modelsDir, filename);
    const ksplatFilename = filename.replace(/\.ply$/i, '.ksplat');
    const ksplatPath = path.join(modelsDir, ksplatFilename);

    // 如果目标文件已存在且更新，则跳过
    if (fs.existsSync(ksplatPath)) {
        const plyStats = fs.statSync(plyPath);
        const ksplatStats = fs.statSync(ksplatPath);
        if (ksplatStats.mtime > plyStats.mtime) {
            return;
        }
    }

    console.log(`🔄 [转换引擎] 检测到 PLY 文件: ${filename}，开始转换为 KSPLAT...`);

    // 定位转换脚本
    // 假设 @mkkellogg/gaussian-splats-3d 安装在 node_modules 中
    // 脚本路径通常为: node_modules/@mkkellogg/gaussian-splats-3d/util/create-ksplat.js
    const scriptPath = path.join(__dirname, 'node_modules', '@mkkellogg', 'gaussian-splats-3d', 'util', 'create-ksplat.js');

    if (!fs.existsSync(scriptPath)) {
        console.error(`✗ 找不到转换脚本: ${scriptPath}`);
        console.error('   请确保已运行 npm install 且依赖版本正确。');
        return;
    }

    return new Promise((resolve, reject) => {
        const start = Date.now();
        const process = spawn('node', [scriptPath, plyPath, ksplatPath]);

        process.stdout.on('data', (data) => {
            // 这里可以过滤输出，只打印关键信息
            // console.log(`[Converter] ${data}`);
        });

        process.stderr.on('data', (data) => {
            console.error(`[Converter Error] ${data}`);
        });

        process.on('close', (code) => {
            const duration = ((Date.now() - start) / 1000).toFixed(2);
            if (code === 0) {
                console.log(`✅ [转换成功] ${ksplatFilename} 生成完毕 (耗时 ${duration}s)`);
                // 可以在这里更新 models.json 或者通知前端
                resolve();
            } else {
                console.error(`❌ [转换失败] 退出代码: ${code}`);
                resolve(); // 即使失败也 resolve，不通过阻塞队列
            }
        });
    });
}

// 监听 models/ 目录
fs.watch(modelsDir, (eventType, filename) => {
    if (filename && filename.toLowerCase().endsWith('.ply')) {
        // 只有在文件变化或重命名(新增)时才触发
        if (fs.existsSync(path.join(modelsDir, filename))) {
            conversionQueue.set(filename, Date.now());
            triggerConversion();
        }
    }
});


// ============================================================================
// 常规服务器配置
// ============================================================================

// 存储前端日志
const frontendLogs = [];
const MAX_LOGS = 200;

// 数据文件路径
const dataFilePath = path.join(__dirname, 'data', 'models.json');
const backgroundsFilePath = path.join(__dirname, 'data', 'backgrounds.json');

// ... (其他原有变量保持不变, 已在上方统一处理目录创建) ...

function resolveLocalPath(urlPath) {
    if (!urlPath) return null;
    return path.join(__dirname, urlPath.replace(/^\/+/, ''));
}

// 初始化数据文件
if (!fs.existsSync(dataFilePath)) {
    fs.writeFileSync(dataFilePath, JSON.stringify([], null, 2));
    console.log('已创建空的模型数据文件');
}

if (!fs.existsSync(backgroundsFilePath)) {
    fs.writeFileSync(backgroundsFilePath, JSON.stringify([], null, 2));
    console.log('已创建空的背景图数据文件');
}

// 配置文件存储
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        if (file.fieldname === 'modelFile') {
            cb(null, modelsDir);
        } else if (file.fieldname === 'thumbnailFile' || file.fieldname === 'backgroundFile') {
            cb(null, imagesDir);
        }
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });

// 中间件
app.use(cors());
app.use(express.json());

// 添加安全头，强制 HTTPS (WebXR 要求)
app.use((req, res, next) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', "upgrade-insecure-requests; default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: wss: https:;"); // 适当放宽 CSP 以支持 blob 和 workers

    // Cross-Origin Isolation headers
    // 管理页面使用更宽松的 COEP 策略以允许 CDN 资源
    // VR页面使用严格的 COEP 策略以支持 SharedArrayBuffer (Gaussian Splats)
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

    if (req.path.startsWith('/admin')) {
        // Admin pages need CDN resources, use relaxed COEP
        res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
    } else {
        // VR pages need SharedArrayBuffer for Gaussian Splats, use strict COEP
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
    next();
});

// 配置静态文件服务 (增强 MIME 类型支持)
app.use(express.static('.', {
    setHeaders: (res, filePath) => {
        const ext = filePath.split('.').pop().toLowerCase();
        switch (ext) {
            case 'gltf':
                res.setHeader('Content-Type', 'model/gltf+json');
                break;
            case 'glb':
                res.setHeader('Content-Type', 'model/gltf-binary');
                break;
            case 'ply':
                res.setHeader('Content-Type', 'model/ply');
                break;
            case 'splat':
            case 'ksplat': // 重点支持
            case 'spz':
                res.setHeader('Content-Type', 'application/octet-stream');
                break;
        }
    }
}));

// API 路由
app.get('/api/models', (req, res) => {
    try {
        const data = fs.readFileSync(dataFilePath, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        console.error('读取模型数据失败:', error);
        res.status(500).json({ error: '读取模型数据失败' });
    }
});

app.post('/api/models', upload.fields([
    { name: 'modelFile', maxCount: 1 },
    { name: 'thumbnailFile', maxCount: 1 }
]), (req, res) => {
    try {
        const { name, description, order, backgroundId } = req.body;
        const modelFile = req.files['modelFile'] ? req.files['modelFile'][0] : null;
        const thumbnailFile = req.files['thumbnailFile'] ? req.files['thumbnailFile'][0] : null;

        if (!modelFile) {
            return res.status(400).json({ error: '缺少模型文件' });
        }

        // 获取文件扩展名
        const fileExt = modelFile.originalname.split('.').pop().toLowerCase();

        const newModel = {
            id: Date.now(),
            name: name || '未命名模型',
            description: description || '',
            path: `/models/${modelFile.filename}`,
            thumbnail: thumbnailFile ? `/images/${thumbnailFile.filename}` : null,
            format: fileExt,
            order: parseInt(order) || 1,
            backgroundId: backgroundId ? parseInt(backgroundId) : null,
            createdAt: new Date().toISOString()
        };

        const data = JSON.parse(fs.readFileSync(dataFilePath, 'utf8'));
        data.push(newModel);
        fs.writeFileSync(dataFilePath, JSON.stringify(data, null, 2));

        console.log('模型已添加:', newModel.name);
        res.json(newModel);
    } catch (error) {
        console.error('添加模型失败:', error);
        res.status(500).json({ error: '添加模型失败: ' + error.message });
    }
});

app.put('/api/models/:id', upload.single('thumbnailFile'), (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, order, backgroundId } = req.body;
        const thumbnailFile = req.file;

        const data = JSON.parse(fs.readFileSync(dataFilePath, 'utf8'));
        const modelIndex = data.findIndex(m => m.id == id || m.id === parseInt(id));

        if (modelIndex === -1) {
            return res.status(404).json({ error: '模型不存在' });
        }

        const model = data[modelIndex];

        // 更新字段
        if (name) model.name = name;
        if (description !== undefined) model.description = description;
        if (order) model.order = parseInt(order);
        if (backgroundId !== undefined) {
            model.backgroundId = backgroundId ? parseInt(backgroundId) : null;
        }

        // 更新缩略图
        if (thumbnailFile) {
            // 删除旧缩略图
            if (model.thumbnail) {
                const oldThumbnailPath = resolveLocalPath(model.thumbnail);
                if (oldThumbnailPath && fs.existsSync(oldThumbnailPath)) {
                    fs.unlinkSync(oldThumbnailPath);
                }
            }
            model.thumbnail = `/images/${thumbnailFile.filename}`;
        }

        model.updatedAt = new Date().toISOString();

        fs.writeFileSync(dataFilePath, JSON.stringify(data, null, 2));

        console.log('模型已更新:', model.name);
        res.json(model);
    } catch (error) {
        console.error('更新模型失败:', error);
        res.status(500).json({ error: '更新模型失败: ' + error.message });
    }
});

app.delete('/api/models/:id', (req, res) => {
    try {
        const { id } = req.params;
        const data = JSON.parse(fs.readFileSync(dataFilePath, 'utf8'));

        // 修复：支持字符串和数字 ID 比较
        const modelIndex = data.findIndex(m => m.id == id || m.id === parseInt(id));

        if (modelIndex === -1) {
            console.error(`模型不存在: ID=${id}, 现有模型:`, data.map(m => m.id));
            return res.status(404).json({ error: '模型不存在' });
        }

        const model = data[modelIndex];

        // 删除文件
        if (model.path) {
            const modelFilePath = resolveLocalPath(model.path);
            if (modelFilePath && fs.existsSync(modelFilePath)) {
                fs.unlinkSync(modelFilePath);
                console.log('已删除模型文件:', modelFilePath);
            }
        }
        if (model.thumbnail) {
            const thumbnailFilePath = resolveLocalPath(model.thumbnail);
            if (thumbnailFilePath && fs.existsSync(thumbnailFilePath)) {
                fs.unlinkSync(thumbnailFilePath);
                console.log('已删除缩略图文件:', thumbnailFilePath);
            }
        }

        data.splice(modelIndex, 1);
        fs.writeFileSync(dataFilePath, JSON.stringify(data, null, 2));

        console.log(`模型已删除: ID=${id}`);
        res.json({ success: true });
    } catch (error) {
        console.error('删除模型失败:', error);
        res.status(500).json({ error: '删除模型失败: ' + error.message });
    }
});

// 批量删除模型
app.post('/api/models/batch-delete', (req, res) => {
    try {
        const { format } = req.body;
        const data = JSON.parse(fs.readFileSync(dataFilePath, 'utf8'));

        let modelsToDelete;
        if (format === 'all') {
            modelsToDelete = [...data];
        } else {
            modelsToDelete = data.filter(m => m.format && m.format.toLowerCase() === format.toLowerCase());
        }

        // 删除文件
        modelsToDelete.forEach(model => {
            if (model.path) {
                const modelFilePath = resolveLocalPath(model.path);
                if (modelFilePath && fs.existsSync(modelFilePath)) {
                    fs.unlinkSync(modelFilePath);
                }
            }
            if (model.thumbnail) {
                const thumbnailFilePath = resolveLocalPath(model.thumbnail);
                if (thumbnailFilePath && fs.existsSync(thumbnailFilePath)) {
                    fs.unlinkSync(thumbnailFilePath);
                }
            }
        });

        // 从数据中移除
        const remainingData = format === 'all' ? [] : data.filter(m => !m.format || m.format.toLowerCase() !== format.toLowerCase());
        fs.writeFileSync(dataFilePath, JSON.stringify(remainingData, null, 2));

        console.log(`批量删除完成: ${modelsToDelete.length} 个模型`);
        res.json({ success: true, deletedCount: modelsToDelete.length });
    } catch (error) {
        console.error('批量删除失败:', error);
        res.status(500).json({ error: '批量删除失败: ' + error.message });
    }
});

// 重新排序模型
app.post('/api/models/reorder', (req, res) => {
    try {
        const { modelId, newPosition } = req.body;
        const data = JSON.parse(fs.readFileSync(dataFilePath, 'utf8'));

        const modelIndex = data.findIndex(m => m.id == modelId || m.id === parseInt(modelId));
        if (modelIndex === -1) {
            return res.status(404).json({ error: '模型不存在' });
        }

        // 移动模型
        const [model] = data.splice(modelIndex, 1);
        data.splice(newPosition, 0, model);

        // 更新 order 字段
        data.forEach((m, index) => {
            m.order = index + 1;
        });

        fs.writeFileSync(dataFilePath, JSON.stringify(data, null, 2));

        console.log(`模型已重新排序: ${model.name}`);
        res.json({ success: true });
    } catch (error) {
        console.error('重新排序失败:', error);
        res.status(500).json({ error: '重新排序失败: ' + error.message });
    }
});

// 背景图 API
app.get('/api/backgrounds', (req, res) => {
    try {
        const data = fs.readFileSync(backgroundsFilePath, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        console.error('读取背景图数据失败:', error);
        res.status(500).json({ error: '读取背景图数据失败' });
    }
});

app.post('/api/backgrounds', upload.single('backgroundFile'), (req, res) => {
    try {
        const { name, description, order } = req.body;
        const backgroundFile = req.file;

        if (!backgroundFile) {
            return res.status(400).json({ error: '缺少背景图文件' });
        }

        const newBackground = {
            id: Date.now(),
            name: name || '未命名背景',
            description: description || '',
            path: `/images/${backgroundFile.filename}`,
            order: parseInt(order) || 1,
            createdAt: new Date().toISOString()
        };

        const data = JSON.parse(fs.readFileSync(backgroundsFilePath, 'utf8'));
        data.push(newBackground);
        fs.writeFileSync(backgroundsFilePath, JSON.stringify(data, null, 2));

        console.log('背景图已添加:', newBackground.name);
        res.json(newBackground);
    } catch (error) {
        console.error('添加背景图失败:', error);
        res.status(500).json({ error: '添加背景图失败: ' + error.message });
    }
});

app.delete('/api/backgrounds/:id', (req, res) => {
    try {
        const { id } = req.params;
        const data = JSON.parse(fs.readFileSync(backgroundsFilePath, 'utf8'));

        // 修复：支持字符串和数字 ID 比较
        const bgIndex = data.findIndex(bg => bg.id == id || bg.id === parseInt(id));

        if (bgIndex === -1) {
            console.error(`背景图不存在: ID=${id}, 现有背景图:`, data.map(b => b.id));
            return res.status(404).json({ error: '背景图不存在' });
        }

        const background = data[bgIndex];

        // 删除文件
        if (background.path) {
            const imageFilePath = resolveLocalPath(background.path);
            if (imageFilePath && fs.existsSync(imageFilePath)) {
                fs.unlinkSync(imageFilePath);
                console.log('已删除背景图文件:', imageFilePath);
            }
        }

        data.splice(bgIndex, 1);
        fs.writeFileSync(backgroundsFilePath, JSON.stringify(data, null, 2));

        console.log(`背景图已删除: ID=${id}`);
        res.json({ success: true });
    } catch (error) {
        console.error('删除背景图失败:', error);
        res.status(500).json({ error: '删除背景图失败: ' + error.message });
    }
});

// 加载 SSL 证书 (支持 mkcert 和传统自签名证书)
function loadSSLCertificates() {
    const certDir = path.join(__dirname, 'cert');

    // 优先查找 mkcert 生成的证书 (文件名格式: localhost+N.pem / localhost+N-key.pem)
    const mkcertFiles = fs.existsSync(certDir) ? fs.readdirSync(certDir) : [];
    const mkcertCert = mkcertFiles.find(f => f.match(/localhost\+\d+\.pem$/));
    const mkcertKey = mkcertFiles.find(f => f.match(/localhost\+\d+-key\.pem$/));

    if (mkcertCert && mkcertKey) {
        console.log('✓ 检测到 mkcert 证书，使用受信任的本地证书');
        try {
            const key = fs.readFileSync(path.join(certDir, mkcertKey), 'utf8');
            const cert = fs.readFileSync(path.join(certDir, mkcertCert), 'utf8');
            return { key, cert };
        } catch (error) {
            console.error('读取 mkcert 证书失败:', error.message);
        }
    }

    // 回退到传统自签名证书
    const keyPath = path.join(certDir, 'key.pem');
    const certPath = path.join(certDir, 'cert.pem');

    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        console.log('⚠️  使用自签名证书（Vision Pro 可能不信任）');
        try {
            const key = fs.readFileSync(keyPath, 'utf8');
            const cert = fs.readFileSync(certPath, 'utf8');

            if (!key || !cert || key.length === 0 || cert.length === 0) {
                throw new Error('证书文件为空');
            }

            return { key, cert };
        } catch (error) {
            console.error('读取证书失败:', error.message);
            throw error;
        }
    }

    // 证书不存在
    console.error('❌ SSL 证书不存在！');
    console.log('');
    console.log('=== 推荐方案 (Vision Pro 兼容) ===');
    console.log('1. 安装 mkcert:  choco install mkcert  或  scoop install mkcert');
    console.log('2. 安装 CA:      mkcert -install');
    console.log('3. 生成证书:     cd cert && mkcert localhost 127.0.0.1 你的IP');
    console.log('');
    console.log('=== 备用方案 (仅用于开发) ===');
    console.log('运行:  npm run cert');
    console.log('');
    throw new Error('缺少 SSL 证书');
}

// 启动 HTTPS 服务器
function loadPreferredSSLCertificates() {
    const certDir = path.join(__dirname, 'cert');
    const preferredKeyPath = path.join(certDir, 'mkcert-key.pem');
    const preferredCertPath = path.join(certDir, 'mkcert-cert.pem');

    if (fs.existsSync(preferredKeyPath) && fs.existsSync(preferredCertPath)) {
        try {
            const key = fs.readFileSync(preferredKeyPath, 'utf8');
            const cert = fs.readFileSync(preferredCertPath, 'utf8');

            if (!key || !cert) {
                throw new Error('certificate file is empty');
            }

            console.log('Using mkcert certificate from cert/mkcert-cert.pem');
            if (fs.existsSync(path.join(certDir, 'rootCA.cer'))) {
                console.log('Install cert/rootCA.cer on Vision Pro and enable full trust.');
            }
            return { key, cert };
        } catch (error) {
            console.error('Failed to read preferred mkcert certificate:', error.message);
        }
    }

    return loadSSLCertificates();
}

const credentials = loadPreferredSSLCertificates();
const httpsServer = https.createServer(credentials, app);

// 创建 WebSocket 服务器用于接收前端日志
const wss = new WebSocket.Server({ server: httpsServer });
let startupErrorHandled = false;

function handleStartupError(source, error) {
    if (startupErrorHandled) return;
    startupErrorHandled = true;

    const code = error?.code || 'UNKNOWN';
    const message = error?.message || String(error);

    if (code === 'EADDRINUSE') {
        console.error(`[Startup:${source}] 端口 ${port} 已被占用，当前实例无法启动。`);
        console.error(`请先关闭已有服务，或改用新端口启动，例如: $env:PORT=3002; npm run dev`);
        console.error(`若需释放端口，可执行: Stop-Process -Id (Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess -Force`);
    } else {
        console.error(`[Startup:${source}] 启动失败 (${code}): ${message}`);
    }

    process.exit(1);
}

// 日志颜色
const colors = {
    LOG: '\x1b[32m',    // 绿色
    WARN: '\x1b[33m',   // 黄色
    ERROR: '\x1b[31m',  // 红色
    INFO: '\x1b[36m',   // 青色
    RESET: '\x1b[0m'
};

wss.on('connection', (ws) => {
    console.log('\x1b[35m[WebSocket]\x1b[0m 前端日志连接已建立');

    ws.on('message', (message) => {
        try {
            const log = JSON.parse(message);

            // 格式化输出到终端
            const color = colors[log.type] || colors.RESET;
            const timestamp = log.timestamp || new Date().toLocaleTimeString('zh-CN', { hour12: false });

            console.log(`${color}[${timestamp}] [${log.type}]${colors.RESET} ${log.message}`);

            // 存储日志
            frontendLogs.push(log);
            if (frontendLogs.length > MAX_LOGS) {
                frontendLogs.shift();
            }
        } catch (e) {
            console.error('解析前端日志失败:', e);
        }
    });

    ws.on('close', () => {
        console.log('\x1b[35m[WebSocket]\x1b[0m 前端日志连接已断开');
    });

    ws.on('error', (error) => {
        console.error('\x1b[35m[WebSocket]\x1b[0m 错误:', error.message);
    });
});

wss.on('error', (error) => {
    handleStartupError('WebSocket', error);
});

httpsServer.on('error', (error) => {
    handleStartupError('HTTPS', error);
});

httpsServer.listen(port, '0.0.0.0', () => {
    console.log('='.repeat(60));
    console.log('VisionPro AR 模块服务器已启动 (HTTPS)');
    console.log('='.repeat(60));
    console.log(`本地访问: https://localhost:${port}`);
    console.log(`网络访问: https://你的IP:${port}`);
    console.log('');
    console.log('⚠️  注意: 使用自签名证书，浏览器会显示安全警告');
    console.log('   在 Vision Pro Safari 中访问时，点击"继续"即可');
    console.log('');
    console.log('\x1b[35m📡 WebSocket 日志服务已启动\x1b[0m');
    console.log('\x1b[35m   前端日志将实时显示在此终端\x1b[0m');
    console.log('Install cert/rootCA.cer on Vision Pro and enable full trust before opening the site.');
    console.log('Then open: https://10.110.161.70:3001');
    console.log('='.repeat(60));
});
