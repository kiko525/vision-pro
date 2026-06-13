const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { X509Certificate } = require('crypto');

const certDir = path.join(__dirname, 'cert');
const configPath = path.join(__dirname, 'cert-config.json');
const certPath = path.join(certDir, 'mkcert-cert.pem');
const keyPath = path.join(certDir, 'mkcert-key.pem');
const rootCAPemPath = path.join(certDir, 'rootCA.pem');
const rootCACerPath = path.join(certDir, 'rootCA.cer');
const forceRegenerate = process.argv.includes('--force') || process.argv.includes('-f');

function resolveMkcertBinary() {
  if (process.platform !== 'win32') {
    return 'mkcert';
  }

  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'mkcert.exe'),
    path.join(
      localAppData,
      'Microsoft',
      'WinGet',
      'Packages',
      'FiloSottile.mkcert_Microsoft.Winget.Source_8wekyb3d8bbwe',
      'mkcert.exe'
    )
  ];

  const hit = candidates.find((candidate) => fs.existsSync(candidate));
  return hit || 'mkcert';
}

const mkcertBinary = resolveMkcertBinary();

function ensureCertDir() {
  if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
  }
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.error('Failed to read cert-config.json:', error.message);
    process.exit(1);
  }
}

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        ips.push(entry.address);
      }
    }
  }

  return ips;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function collectHosts(config) {
  const dnsEntries = unique([
    'localhost',
    ...((config.certificate && config.certificate.subjectAltName && config.certificate.subjectAltName.dns) || [])
  ]).filter((value) => !value.includes('YOUR_'));

  const ipEntries = unique([
    '127.0.0.1',
    '::1',
    ...((config.certificate && config.certificate.subjectAltName && config.certificate.subjectAltName.ip) || []),
    ...getLocalIPs()
  ]).filter((value) => !value.includes('YOUR_'));

  return [...dnsEntries, ...ipEntries];
}

function runMkcert(args, stepLabel) {
  const result = spawnSync(mkcertBinary, args, {
    cwd: __dirname,
    encoding: 'utf8',
    windowsHide: true
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      console.error('mkcert is not installed or not in PATH.');
      console.error('Install it first with: winget install FiloSottile.mkcert');
      console.error('If you just installed it, re-open the terminal and run npm run cert again.');
    } else {
      console.error(`mkcert failed during "${stepLabel}":`, result.error.message);
    }
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`mkcert command failed during "${stepLabel}".`);
    if (result.stdout && result.stdout.trim()) {
      console.error(result.stdout.trim());
    }
    if (result.stderr && result.stderr.trim()) {
      console.error(result.stderr.trim());
    }
    process.exit(result.status || 1);
  }

  return (result.stdout || '').trim();
}

function exportRootCA() {
  const caroot = runMkcert(['-CAROOT'], 'resolve CA root');
  const sourceRootCA = path.join(caroot, 'rootCA.pem');

  if (!fs.existsSync(sourceRootCA)) {
    console.error('mkcert rootCA.pem was not found at:', sourceRootCA);
    process.exit(1);
  }

  fs.copyFileSync(sourceRootCA, rootCAPemPath);

  const rootCertificate = new X509Certificate(fs.readFileSync(sourceRootCA, 'utf8'));
  fs.writeFileSync(rootCACerPath, rootCertificate.raw);
}

function printSummary(hosts) {
  console.log('');
  console.log('mkcert certificate is ready.');
  console.log(`Server cert: ${certPath}`);
  console.log(`Server key : ${keyPath}`);
  console.log(`Root CA PEM: ${rootCAPemPath}`);
  console.log(`Root CA CER: ${rootCACerPath}`);
  console.log('');
  console.log('Hosts covered by the certificate:');
  for (const host of hosts) {
    console.log(`  - ${host}`);
  }
  console.log('');
  console.log('Next steps:');
  console.log('  1. Install cert/rootCA.cer on Apple Vision Pro and enable full trust.');
  console.log('  2. Start the site with: npm run dev');
  console.log('  3. Open: https://10.110.161.70:3001');
}

ensureCertDir();

const config = readConfig();
const hosts = collectHosts(config);

if (!forceRegenerate && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  console.log('Ensuring local mkcert CA is installed...');
  runMkcert(['-install'], 'install local CA');
  exportRootCA();
  console.log('mkcert certificate already exists.');
  printSummary(hosts);
  process.exit(0);
}

console.log('Installing local mkcert CA...');
runMkcert(['-install'], 'install local CA');

console.log('Generating mkcert HTTPS certificate...');
runMkcert(
  ['-cert-file', certPath, '-key-file', keyPath, ...hosts],
  'generate certificate'
);

exportRootCA();
printSummary(hosts);
