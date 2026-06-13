// 生成自签名证书的脚本 - 基于配置文件
const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const os = require('os');

const certDir = path.join(__dirname, 'cert');
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');
const configPath = path.join(__dirname, 'cert-config.json');

// 创建证书目录
if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
    console.log('✓ 创建 cert 目录');
}

// 读取配置文件
let config;
try {
    const configContent = fs.readFileSync(configPath, 'utf8');
    config = JSON.parse(configContent);
    console.log('✓ 读取配置文件: cert-config.json\n');
} catch (error) {
    console.error('✗ 无法读取配置文件 cert-config.json');
    console.error('  请确保文件存在且格式正确');
    process.exit(1);
}

// 检查是否强制重新生成
const forceRegenerate = process.argv.includes('--force') || process.argv.includes('-f');

// 检查证书是否已存在
if (!forceRegenerate && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    console.log('✓ SSL证书已存在');
    console.log(`  密钥: ${keyPath}`);
    console.log(`  证书: ${certPath}`);
    console.log('\n提示: 使用 npm run cert:selfsigned:force 强制重新生成\n');
    process.exit(0);
}

// 获取本机所有网络接口IP
function getLocalIPs() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // 跳过内部和非IPv4地址
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push(iface.address);
            }
        }
    }
    
    return ips;
}

// 显示配置信息
console.log('========================================');
console.log('  生成自签名SSL证书');
console.log('========================================\n');

const certConfig = config.certificate;
const localIPs = getLocalIPs();

console.log('📋 证书配置信息:');
console.log(`  通用名称: ${certConfig.subject.commonName}`);
console.log(`  组织: ${certConfig.subject.organizationName}`);
console.log(`  有效期: ${certConfig.validity.years} 年`);
console.log('');

console.log('🌐 检测到的本机IP地址:');
localIPs.forEach(ip => {
    console.log(`  - ${ip}`);
});
console.log('');

console.log('📝 配置文件中的地址:');
console.log('  DNS 名称:');
certConfig.subjectAltName.dns.forEach(dns => {
    console.log(`    - ${dns}`);
});
console.log('  IP 地址:');
certConfig.subjectAltName.ip.forEach(ip => {
    console.log(`    - ${ip}`);
});
console.log('');

// 检查配置中是否包含占位符
const hasPlaceholder = JSON.stringify(config).includes('YOUR_SERVER_IP') || 
                       JSON.stringify(config).includes('YOUR_DOMAIN');

if (hasPlaceholder) {
    console.log('⚠️  警告: 配置文件中包含占位符');
    console.log('  请编辑 cert-config.json 文件:');
    console.log('  1. 将 YOUR_SERVER_IP 替换为实际的服务器IP');
    console.log('  2. 将 YOUR_DOMAIN.com 替换为实际的域名（如果有）');
    console.log('  3. 或者删除这些占位符条目\n');
}

try {
    // 生成密钥对
    console.log('🔑 1. 生成RSA密钥对 (2048位)...');
    const keys = forge.pki.rsa.generateKeyPair(2048);
    console.log('   ✓ 密钥对生成完成');
    
    // 创建证书
    console.log('📜 2. 创建证书...');
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = Date.now().toString();
    
    // 设置有效期
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(
        cert.validity.notBefore.getFullYear() + certConfig.validity.years
    );
    
    // 设置主题信息
    const attrs = [
        { name: 'commonName', value: certConfig.subject.commonName },
        { name: 'countryName', value: certConfig.subject.countryName },
        { shortName: 'ST', value: certConfig.subject.stateOrProvinceName },
        { name: 'localityName', value: certConfig.subject.localityName },
        { name: 'organizationName', value: certConfig.subject.organizationName },
        { shortName: 'OU', value: certConfig.subject.organizationalUnitName }
    ];
    
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    console.log('   ✓ 证书主题信息设置完成');
    
    // 构建 SAN (Subject Alternative Name) 扩展
    const altNames = [];
    
    // 添加DNS名称
    certConfig.subjectAltName.dns.forEach(dns => {
        if (dns && !dns.includes('YOUR_')) {
            altNames.push({ type: 2, value: dns });
        }
    });
    
    // 添加IP地址
    certConfig.subjectAltName.ip.forEach(ip => {
        if (ip && !ip.includes('YOUR_')) {
            altNames.push({ type: 7, ip: ip });
        }
    });
    
    console.log('🔐 3. 配置证书扩展...');
    
    // 设置扩展
    const extensions = [
        {
            name: 'basicConstraints',
            cA: certConfig.extensions.basicConstraints.cA
        },
        {
            name: 'keyUsage',
            keyCertSign: certConfig.extensions.keyUsage.keyCertSign,
            digitalSignature: certConfig.extensions.keyUsage.digitalSignature,
            nonRepudiation: certConfig.extensions.keyUsage.nonRepudiation,
            keyEncipherment: certConfig.extensions.keyUsage.keyEncipherment,
            dataEncipherment: certConfig.extensions.keyUsage.dataEncipherment
        },
        {
            name: 'extKeyUsage',
            serverAuth: certConfig.extensions.extKeyUsage.serverAuth,
            clientAuth: certConfig.extensions.extKeyUsage.clientAuth
        },
        {
            name: 'subjectAltName',
            altNames: altNames
        }
    ];
    
    cert.setExtensions(extensions);
    console.log(`   ✓ 添加了 ${altNames.length} 个备用名称`);
    
    // 自签名
    console.log('✍️  4. 签名证书...');
    cert.sign(keys.privateKey, forge.md.sha256.create());
    console.log('   ✓ 证书签名完成');
    
    // 转换为PEM格式
    const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
    const certPem = forge.pki.certificateToPem(cert);
    
    // 保存到文件
    console.log('💾 5. 保存证书文件...');
    fs.writeFileSync(keyPath, privateKeyPem, 'utf8');
    fs.writeFileSync(certPath, certPem, 'utf8');
    console.log('   ✓ 文件保存完成');

    console.log('\n========================================');
    console.log('✅ SSL证书生成成功！');
    console.log('========================================');
    console.log(`📁 证书位置:`);
    console.log(`   密钥: ${keyPath}`);
    console.log(`   证书: ${certPath}`);
    console.log('');
    console.log('📅 有效期:');
    console.log(`   开始: ${cert.validity.notBefore.toLocaleString('zh-CN')}`);
    console.log(`   结束: ${cert.validity.notAfter.toLocaleString('zh-CN')}`);
    console.log('');
    console.log('🌐 支持的地址:');
    altNames.forEach(alt => {
        if (alt.type === 2) {
            console.log(`   DNS: ${alt.value}`);
        } else if (alt.type === 7) {
            console.log(`   IP:  ${alt.ip}`);
        }
    });
    console.log('');
    console.log('⚠️  注意事项:');
    console.log('   1. 这是自签名证书，浏览器会显示安全警告');
    console.log('   2. 在 Vision Pro Safari 中首次访问时:');
    console.log('      - 点击"显示详细信息"');
    console.log('      - 点击"访问此网站"');
    console.log('   3. 部署到服务器时，复制整个 cert/ 目录');
    console.log('   4. 如果有公网域名，建议使用 Let\'s Encrypt 证书');
    console.log('');
    console.log('🚀 下一步:');
    console.log('   运行: npm start');
    console.log(`   访问: https://${localIPs[0] || '10.100.36.40'}:3001`);
    console.log('========================================\n');
    
} catch (error) {
    console.error('\n========================================');
    console.error('❌ 生成证书失败');
    console.error('========================================');
    console.error('错误信息:', error.message);
    console.error('');
    console.error('可能的原因:');
    console.error('  1. cert-config.json 格式错误');
    console.error('  2. 缺少必要的依赖包');
    console.error('  3. 文件权限问题');
    console.error('');
    console.error('解决方法:');
    console.error('  1. 检查 cert-config.json 格式');
    console.error('  2. 运行: npm install');
    console.error('  3. 以管理员权限运行');
    console.error('========================================\n');
    process.exit(1);
}
