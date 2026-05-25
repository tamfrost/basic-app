#!/usr/bin/env node

const { select, confirm } = require('@inquirer/prompts');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '../.env');
function reloadEnv() { require('dotenv').config({ path: ENV_PATH, override: true }); }
reloadEnv();

const readline = require('readline');
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('keypress', (_, key) => {
  if (key && key.name === 'escape') process.exit(0);
});

function runCommand(command, options = {}) {
  const { execSync } = require('child_process');
  const isWindows = process.platform === 'win32';

  const defaultOptions = {
    shell: isWindows ? 'powershell.exe' : true,
    ...options
  };

  if (isWindows && command.includes('2>/dev/null')) {
    command = command.replace(/2>\/dev\/null/g, '2>$null');
  }

  return execSync(command, defaultOptions);
}

const certPath = path.join(__dirname, '../certs/canna-ca-bundle.crt');
let ca = undefined;
if (fs.existsSync(certPath)) {
  ca = fs.readFileSync(certPath);
  console.log(`Loaded CA certificates from: ${certPath}\n`);
}

let proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
if (proxy) {
  proxy = proxy.replace(/\/$/, '');
  console.log(`Using proxy: ${proxy}\n`);
}

const agentOptions = {};
if (ca) agentOptions.ca = ca;

let httpsAgent = undefined;
if (proxy) httpsAgent = new HttpsProxyAgent(proxy, agentOptions);

const GTHB_API_URL = (process.env.GTHB_API_URL || 'https://api.github.com').replace(/\/$/, '');

const axiosInstance = axios.create({
  httpsAgent,
  timeout: 60000,
  headers: {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
});

function createGitHubAppJWT() {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iat: now - 60, exp: now + (10 * 60), iss: process.env.AUTH_APP_ID },
    process.env.AUTH_APP_PRIVATE_KEY,
    { algorithm: 'RS256' }
  );
}

async function getInstallationToken() {
  const response = await axiosInstance.post(
    `${GTHB_API_URL}/app/installations/${process.env.AUTH_APP_INSTALLATION_ID}/access_tokens`,
    {},
    { headers: { 'Authorization': `Bearer ${createGitHubAppJWT()}` } }
  );
  return response.data.token;
}

function getRepoInfoFromGitConfig() {
  const { execSync } = require('child_process');
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8'
    }).trim();
    const match = remoteUrl.match(/(?:https?:\/\/(?:[^@\/]+@)?[^\/]*github[^\/]*\/|git@[^:]+:)([^\/]+)\/(.+?)(?:\.git)?$/);
    return match ? { owner: match[1], repo: match[2] } : null;
  } catch (_) {
    return null;
  }
}

async function getGitHubVariables() {
  try {
    console.log('Authenticating with GitHub App...');
    const token = await getInstallationToken();
    console.log('✓ Successfully authenticated\n');

    let repoInfo;
    repoInfo = getRepoInfoFromGitConfig();
    if (repoInfo) console.log(`Using repository from git config: ${repoInfo.owner}/${repoInfo.repo}`);

    if (!repoInfo) {
      console.error('Error: Could not determine repository info.');
      return;
    }

    const { owner, repo } = repoInfo;
    console.log(`Fetching variables for ${owner}/${repo}...\n`);

    const repoVarsResponse = await axiosInstance.get(
      `${GTHB_API_URL}/repos/${owner}/${repo}/actions/variables`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );

    console.log('=== Repository Variables ===');
    if (repoVarsResponse.data.variables?.length > 0) {
      repoVarsResponse.data.variables.forEach(v => console.log(`${v.name}: ${v.value}`));
    } else {
      console.log('No repository variables found.');
    }

    try {
      const orgVarsResponse = await axiosInstance.get(
        `${GTHB_API_URL}/orgs/${owner}/actions/variables`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      console.log('\n=== Organization Variables ===');
      if (orgVarsResponse.data.variables?.length > 0) {
        orgVarsResponse.data.variables.forEach(v => console.log(`${v.name}: ${v.value}`));
      } else {
        console.log('No organization variables found.');
      }
    } catch (error) {
      console.log('\n=== Organization Variables ===');
      if (error.response?.status === 404) {
        console.log('Not an organization or no access to organization variables.');
      } else {
        console.log('Unable to fetch organization variables:', error.message);
      }
    }

  } catch (error) {
    console.error('\nError:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Response:', error.response.data);
      if (error.response.status === 403) {
        console.error('\n⚠️  The GitHub App does not have permission to access Actions variables.');
        console.error('Set "Variables" to "Read-only" under Repository permissions in your GitHub App settings.');
      }
    }
  }
}

async function deployApp() {
  const registry   = process.env.CONTAINER_REGISTRY    || 'ghcr.io';
  const repository = process.env.CONTAINER_REPOSITORY  || 'tamfrost/basic-app';
  const chartPath  = path.join(__dirname, '../.helm/app');
  const { name: appName, namespace, routeHost } = getAppConfig();

  ensureNamespace(namespace);
  console.log(`\nDeploying ${appName} to ${namespace}...`);
  try {
    runCommand(
      `helm upgrade --install ${appName} "${chartPath}" ` +
      `--create-namespace --namespace ${namespace} ` +
      `--set appName="${appName}" ` +
      `--set namespace="${namespace}" ` +
      `--set image.registry="${registry}" ` +
      `--set image.repository="${repository}" ` +
      `--set route.enabled=true ` +
      (routeHost ? `--set route.host="${routeHost}" ` : '') +
      appConfigSetFileFlags(),
      { stdio: 'inherit' }
    );
    console.log(`\n✓ ${appName} deployed`);
    try {
      const route = runCommand(`kubectl get route ${appName} -n ${namespace} -o jsonpath="{.spec.host}" 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (route) console.log(`🌐 https://${route}`);
    } catch (_) {}
  } catch (error) {
    console.error('\nDeploy failed:', error.message);
  }
}

async function deleteApp() {
  const { name: appName, namespace } = getAppConfig();
  const ok = await confirm({ message: `Delete ${appName} from namespace ${namespace}?`, default: false });
  if (!ok) { console.log('Cancelled.'); return; }
  silentlyRemoveArgoCDApp(appName);
  try { runCommand(`helm uninstall ${appName} --namespace ${namespace}`, { stdio: 'inherit' }); } catch (_) {}
  cleanupNamespace(namespace);
  console.log(`\n✓ ${appName} deleted`);
}

async function deployAppX509() {
  const registry   = process.env.CONTAINER_REGISTRY   || 'ghcr.io';
  const repository = process.env.CONTAINER_REPOSITORY || 'tamfrost/basic-app';
  const chartPath  = path.join(__dirname, '../.helm/app-x509');
  const caCertPath = path.resolve(__dirname, '..', process.env.CLIENT_CERT_FILE || 'certs/client/ca-cert.pem').replace(/\\/g, '/');
  const { name: releaseName, namespace, routeHost } = getAppConfig();

  const nginxTlsDirect = ensureNginxTlsDirect();
  const nginxCa        = nginxTlsDirect ? null : ensureNginxCa();
  const acmeUrl        = (nginxTlsDirect || nginxCa) ? '-' : (process.env.ACME_DIRECTORY_URL || '-');
  const acmeIssuerName = (process.env.ACME_ISSUER_NAME && process.env.ACME_ISSUER_NAME !== '-') ? process.env.ACME_ISSUER_NAME : 'internal-ca';
  const pomerium       = !nginxTlsDirect && !nginxCa && acmeUrl === '-' && hasPomerium();

  logCertMode(nginxCa, acmeUrl, nginxTlsDirect, pomerium);
  ensureNamespace(namespace);
  const tlsSecretName = `${releaseName}-nginx-tls`;
  if (nginxTlsDirect) {
    console.log(`\nCreating TLS secret from ${process.env.NGINX_TLS_CERT_FILE}...`);
    runCommand(
      `kubectl create secret tls ${tlsSecretName} --cert="${nginxTlsDirect.certPath}" --key="${nginxTlsDirect.keyPath}" ` +
      `-n ${namespace} --dry-run=client -o yaml | kubectl apply -f -`,
      { stdio: 'inherit' }
    );
  }
  adoptHelmSecret(tlsSecretName, namespace, releaseName);
  console.log(`\nDeploying ${releaseName} (x509) to ${namespace}...`);
  try {
    runCommand(
      `helm upgrade --install ${releaseName} "${chartPath}" ` +
      `--create-namespace --namespace ${namespace} ` +
      `--set appName="${releaseName}" ` +
      `--set namespace="${namespace}" ` +
      `--set image.registry="${registry}" ` +
      `--set image.repository="${repository}" ` +
      `--set-file caCert="${caCertPath}" ` +
      `--set acmeDirectoryUrl="${acmeUrl}" ` +
      `--set acmeIssuerName="${acmeIssuerName}" ` +
      (routeHost ? `--set route.host="${routeHost}" ` : '') +
      (nginxCa ? `--set-file nginxCaCert="${nginxCa.certPath}" --set-file nginxCaKey="${nginxCa.keyPath}" ` : '') +
      `--set pomeriumIngress="${pomerium}" ` +
      appConfigSetFileFlags(),
      { stdio: 'inherit' }
    );
    console.log(`\n✓ ${releaseName} deployed`);
    if ((acmeUrl && acmeUrl !== '-') || pomerium) waitForCertAndRestartNginx(namespace, releaseName);
    else showCertStatus(namespace, releaseName);
    try {
      const route = runCommand(`kubectl get route ${releaseName} -n ${namespace} -o jsonpath="{.spec.host}" 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (route) console.log(`🌐 https://${route}  (requires client cert)`);
    } catch (_) {}
  } catch (error) {
    console.error('\nDeploy failed:', error.message);
    showCertStatus(namespace, releaseName);
  }
}

async function deleteAppX509() {
  const { name: appName, namespace } = getAppConfig();
  const ok = await confirm({ message: `Delete ${appName} (x509) from namespace ${namespace}?`, default: false });
  if (!ok) { console.log('Cancelled.'); return; }
  silentlyRemoveArgoCDApp(`${appName}-x509`);
  try { runCommand(`helm uninstall ${appName} --namespace ${namespace}`, { stdio: 'inherit' }); } catch (_) {}
  cleanupNamespace(namespace);
  console.log(`\n✓ ${appName} (x509) deleted`);
}

async function deployAppOAuth2() {
  const registry   = process.env.CONTAINER_REGISTRY   || 'ghcr.io';
  const repository = process.env.CONTAINER_REPOSITORY || 'tamfrost/basic-app';
  const chartPath  = path.join(__dirname, '../.helm/app-oauth2');
  const { name: releaseName, namespace, routeHost } = getAppConfig();

  const clientID      = process.env.OAUTH2_CLIENT_ID       || '';
  const clientSecret  = process.env.OAUTH2_CLIENT_SECRET   || '';
  const cookieSecret  = process.env.OAUTH2_COOKIE_SECRET   || '';
  const issuerUrl     = process.env.OAUTH2_OIDC_ISSUER_URL || '';
  const redirectUrl   = process.env.OAUTH2_REDIRECT_URL    || (routeHost ? `https://${routeHost}/oauth2/callback` : '');
  const allowedGroups = process.env.OAUTH2_ALLOWED_GROUPS  || '-';

  const providerCertFile = process.env.PROVIDER_CERT_FILE;
  const providerCertPath = (providerCertFile && providerCertFile !== '-')
    ? path.resolve(__dirname, '..', providerCertFile).replace(/\\/g, '/')
    : null;

  const nginxTlsDirect = ensureNginxTlsDirect();
  const nginxCa        = nginxTlsDirect ? null : ensureNginxCa();
  const acmeUrl        = (nginxTlsDirect || nginxCa) ? '-' : (process.env.ACME_DIRECTORY_URL || '-');
  const acmeIssuerName = (process.env.ACME_ISSUER_NAME && process.env.ACME_ISSUER_NAME !== '-') ? process.env.ACME_ISSUER_NAME : 'internal-ca';
  const pomerium       = !nginxTlsDirect && !nginxCa && acmeUrl === '-' && hasPomerium();

  logCertMode(nginxCa, acmeUrl, nginxTlsDirect, pomerium);
  ensureNamespace(namespace);
  const tlsSecretName = `${releaseName}-nginx-tls`;
  if (nginxTlsDirect) {
    console.log(`\nCreating TLS secret from ${process.env.NGINX_TLS_CERT_FILE}...`);
    runCommand(
      `kubectl create secret tls ${tlsSecretName} --cert="${nginxTlsDirect.certPath}" --key="${nginxTlsDirect.keyPath}" ` +
      `-n ${namespace} --dry-run=client -o yaml | kubectl apply -f -`,
      { stdio: 'inherit' }
    );
  }
  adoptHelmSecret(tlsSecretName, namespace, releaseName);
  console.log(`\nDeploying ${releaseName} (oauth2) to ${namespace}...`);
  try {
    const cmd =
      `helm upgrade --install ${releaseName} "${chartPath}" ` +
      `--create-namespace --namespace ${namespace} ` +
      `--set appName="${releaseName}" ` +
      `--set namespace="${namespace}" ` +
      `--set image.registry="${registry}" ` +
      `--set image.repository="${repository}" ` +
      `--set oauth2Proxy.clientID="${clientID}" ` +
      `--set oauth2Proxy.clientSecret="${clientSecret}" ` +
      `--set oauth2Proxy.cookieSecret="${cookieSecret}" ` +
      `--set oauth2Proxy.oidcIssuerUrl="${issuerUrl}" ` +
      `--set oauth2Proxy.redirectUrl="${redirectUrl}" ` +
      `--set oauth2Proxy.allowedGroups="${allowedGroups.replace(/,/g, '\\,')}" ` +
      `--set acmeDirectoryUrl="${acmeUrl}" ` +
      `--set acmeIssuerName="${acmeIssuerName}" ` +
      (routeHost ? `--set route.host="${routeHost}" ` : '') +
      (nginxCa ? `--set-file nginxCaCert="${nginxCa.certPath}" --set-file nginxCaKey="${nginxCa.keyPath}" ` : '') +
      (providerCertPath ? `--set-file oauth2Proxy.providerCaCert="${providerCertPath}" ` : '') +
      `--set pomeriumIngress="${pomerium}" ` +
      appConfigSetFileFlags();
    runCommand(cmd, { stdio: 'inherit' });
    console.log(`\n✓ ${releaseName} deployed`);
    if ((acmeUrl && acmeUrl !== '-') || pomerium) waitForCertAndRestartNginx(namespace, releaseName);
    else showCertStatus(namespace, releaseName);
    try {
      const route = runCommand(`kubectl get route ${releaseName} -n ${namespace} -o jsonpath="{.spec.host}" 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (route) console.log(`🌐 https://${route}  (x509 + oauth2)`);
    } catch (_) {}
  } catch (error) {
    console.error('\nDeploy failed:', error.message);
    showCertStatus(namespace, releaseName);
  }
}

async function deleteAppOAuth2() {
  const { name: appName, namespace } = getAppConfig();
  const ok = await confirm({ message: `Delete ${appName} (oauth2) from namespace ${namespace}?`, default: false });
  if (!ok) { console.log('Cancelled.'); return; }
  silentlyRemoveArgoCDApp(`${appName}-oauth2`);
  try { runCommand(`helm uninstall ${appName} --namespace ${namespace}`, { stdio: 'inherit' }); } catch (_) {}
  cleanupNamespace(namespace);
  console.log(`\n✓ ${appName} (oauth2) deleted`);
}

function hasPomerium() {
  try {
    runCommand('kubectl get ingressclass pomerium 2>/dev/null', { stdio: 'pipe' });
    return true;
  } catch (_) { return false; }
}

function getClusterDomain() {
  try {
    return runCommand(
      `kubectl get ingresses.config.openshift.io cluster -o jsonpath="{.spec.domain}" 2>/dev/null`,
      { encoding: 'utf8' }
    ).trim();
  } catch (_) { return ''; }
}

function getAppConfig() {
  const name      = process.env.APP_NAME      || 'basic-app';
  const namespace = process.env.APP_NAMESPACE || name;
  const address   = process.env.APP_ADDRESS;
  const host      = (address && address !== '-') ? address : `${name}-${namespace}`;
  const domain    = getClusterDomain();
  const routeHost = domain ? `${host}.${domain}` : '';
  return { name, namespace, routeHost };
}

function ensureNamespace(namespace) {
  try {
    runCommand(
      `kubectl create namespace ${namespace} --dry-run=client -o yaml | kubectl apply -f -`,
      { stdio: 'pipe' }
    );
  } catch (_) {}
}

function appConfigSetFileFlags() {
  const configDir = path.join(__dirname, '../app-config');
  const files = { js: 'config.js', json: 'config.json', yaml: 'config.yaml' };
  return Object.entries(files)
    .filter(([, name]) => fs.existsSync(path.join(configDir, name)))
    .map(([key, name]) => `--set-file "appConfig.${key}=${path.join(configDir, name).replace(/\\/g, '/')}"`)
    .join(' ');
}

function appConfigExtraLines() {
  const configDir = path.join(__dirname, '../app-config');
  const files = { js: 'config.js', json: 'config.json', yaml: 'config.yaml' };
  const lines = [];
  const entries = Object.entries(files).filter(([, name]) => fs.existsSync(path.join(configDir, name)));
  if (entries.length === 0) return lines;
  lines.push('appConfig:');
  for (const [key, name] of entries) {
    lines.push(`  ${key}: |`);
    fs.readFileSync(path.join(configDir, name), 'utf8').trimEnd().split('\n').forEach(l => lines.push(`    ${l}`));
  }
  return lines;
}

function adoptHelmSecret(secretName, namespace, releaseName) {
  try {
    runCommand(
      `kubectl annotate secret ${secretName} -n ${namespace} ` +
      `"meta.helm.sh/release-name=${releaseName}" "meta.helm.sh/release-namespace=${namespace}" --overwrite 2>/dev/null`,
      { stdio: 'pipe' }
    );
    runCommand(
      `kubectl label secret ${secretName} -n ${namespace} "app.kubernetes.io/managed-by=Helm" --overwrite 2>/dev/null`,
      { stdio: 'pipe' }
    );
  } catch (_) {}
}

function ensureNginxTlsDirect() {
  const certFile = process.env.NGINX_TLS_CERT_FILE;
  const keyFile  = process.env.NGINX_TLS_KEY_FILE;
  if (!certFile || certFile === '-' || !keyFile || keyFile === '-') return null;

  const certPath = path.resolve(__dirname, '..', certFile);
  const keyPath  = path.resolve(__dirname, '..', keyFile);

  if (!fs.existsSync(certPath)) { console.error(`\nTLS cert not found: ${certFile}`); process.exit(1); }
  if (!fs.existsSync(keyPath))  { console.error(`\nTLS key not found: ${keyFile}`);  process.exit(1); }

  return {
    certPath: certPath.replace(/\\/g, '/'),
    keyPath:  keyPath.replace(/\\/g, '/'),
  };
}

function ensureNginxCa() {
  const certFile = process.env.CA_ROOT_CERT_FILE;
  const keyFile  = process.env.CA_ROOT_CERT_KEY;
  if (!certFile || certFile === '-' || !keyFile || keyFile === '-') return null;

  const certPath = path.resolve(__dirname, '..', certFile);
  const keyPath  = path.resolve(__dirname, '..', keyFile);

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    console.error(`\nCA cert/key not found: ${certFile} / ${keyFile}`);
    console.error('Generate them once with: openssl req -x509 -newkey rsa:4096 -keyout <key> -out <cert> -days 3650 -nodes -subj "/CN=CRC-root-ca"');
    return null;
  }

  return {
    certPath: certPath.replace(/\\/g, '/'),
    keyPath:  keyPath.replace(/\\/g, '/'),
    cert: fs.readFileSync(certPath, 'utf8').trim(),
    key:  fs.readFileSync(keyPath,  'utf8').trim(),
  };
}


function logCertMode(nginxCa, acmeUrl, nginxTlsDirect, pomerium = false) {
  if (nginxTlsDirect) {
    console.log(`\n📋 TLS mode: pre-supplied cert  (${nginxTlsDirect.certPath})`);
    return;
  }
  if (nginxCa) {
    console.log(`\n📋 TLS mode: local CA  (${nginxCa.certPath})`);
    return;
  }
  if (pomerium) {
    console.log('\n📋 TLS mode: Pomerium (cert-manager via Pomerium Ingress)');
    try {
      runCommand('kubectl get crd certificates.cert-manager.io 2>/dev/null', { stdio: 'pipe' });
      console.log('   cert-manager: ✓ CRDs present');
    } catch (_) {
      console.warn('   cert-manager: ✗ CRDs NOT found — deploy will fail');
    }
    return;
  }
  if (acmeUrl && acmeUrl !== '-') {
    console.log(`\n📋 TLS mode: cert-manager / ACME  (${acmeUrl})`);
    try {
      runCommand('kubectl get crd certificates.cert-manager.io 2>/dev/null', { stdio: 'pipe' });
      console.log('   cert-manager: ✓ CRDs present');
    } catch (_) {
      console.warn('   cert-manager: ✗ CRDs NOT found — deploy will fail');
      console.warn('   Install cert-manager or set CA_ROOT_CERT_FILE / CA_ROOT_CERT_KEY to use a local CA instead');
    }
    try {
      const issuers = runCommand('kubectl get clusterissuer 2>/dev/null', { encoding: 'utf8' }).trim();
      if (issuers) { console.log('   ClusterIssuers:\n' + issuers.split('\n').map(l => '     ' + l).join('\n')); }
    } catch (_) {}
  } else {
    console.log('\n📋 TLS mode: self-signed (fallback)');
  }
}

function showCertStatus(namespace, releaseName, acmeMode = false) {
  console.log('\n--- Certificate status ---');
  if (acmeMode) {
    try {
      const certs = runCommand(`kubectl get certificate,certificaterequest -n ${namespace} 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (certs) console.log(certs);
    } catch (_) {}
  }

  try {
    const secret = runCommand(
      `kubectl get secret ${releaseName}-nginx-tls -n ${namespace} -o jsonpath="{.data['tls\\.crt']}" 2>/dev/null`,
      { encoding: 'utf8' }
    ).trim();
    if (secret) {
      const pem = Buffer.from(secret, 'base64').toString('utf8');
      const subject = (pem.match(/subject=([^\n]+)/) || [])[1] || '';
      const san     = (pem.match(/DNS:([^\n,]+)/)    || [])[1] || '';
      const notBefore = pem.match(/Not Before\s*:\s*([^\n]+)/i);
      const notAfter  = pem.match(/Not After\s*:\s*([^\n]+)/i);

      // Extract fields from PEM using basic ASN.1 text decoding via crypto
      const crypto = require('crypto');
      try {
        const cert = new crypto.X509Certificate(pem);
        console.log(`  TLS secret: ${releaseName}-nginx-tls`);
        console.log(`  subject:    ${cert.subject}`);
        console.log(`  issuer:     ${cert.issuer}`);
        console.log(`  valid from: ${cert.validFrom}`);
        console.log(`  valid to:   ${cert.validTo}`);
        console.log(`  SANs:       ${cert.subjectAltName || '(none)'}`);
      } catch (_) {
        console.log(`  TLS secret: ${releaseName}-nginx-tls  (could not parse cert)`);
      }
    } else {
      console.log(`  TLS secret ${releaseName}-nginx-tls: not found yet`);
    }
  } catch (_) {}
  console.log('--------------------------');
}

function waitForCertAndRestartNginx(namespace, releaseName) {
  console.log('\nWaiting for certificate to become Ready (timeout 120s)...');
  try {
    runCommand(
      `kubectl wait certificate/${releaseName}-nginx-tls -n ${namespace} --for=condition=Ready --timeout=120s`,
      { stdio: 'inherit' }
    );
    console.log('Certificate ready. Restarting nginx to pick up the real cert...');
    runCommand(`kubectl rollout restart deployment/${releaseName}-nginx -n ${namespace}`, { stdio: 'inherit' });
    runCommand(`kubectl rollout status deployment/${releaseName}-nginx -n ${namespace} --timeout=60s`, { stdio: 'inherit' });
    showCertStatus(namespace, releaseName, true);
  } catch (_) {
    console.warn('⚠️  Certificate did not become Ready within 120s. Check cert-manager logs:');
    console.warn(`   kubectl describe certificate ${releaseName}-nginx-tls -n ${namespace}`);
    console.warn(`   kubectl logs -n $(kubectl get ns | grep cert-manager | head -1 | awk '{print $1}') deployment/cert-manager`);
  }
}

function getGitHubAppPrivateKey() {
  let key = process.env.AUTH_APP_PRIVATE_KEY;
  if (!key) throw new Error('AUTH_APP_PRIVATE_KEY not found in .env file');
  key = key.replace(/^["']|["']$/g, '');
  key = key.replace(/\\n/g, '\n');
  key = key.replace(/\r/g, '');
  return key;
}

function grantArgoCDPermissions() {
  const { name: appName, namespace } = getAppConfig();
  const argoCDNS = process.env.ARGOCD_NAMESPACE || 'openshift-gitops';
  const argoSA   = `${argoCDNS}-argocd-application-controller`;
  console.log(`\nGranting ArgoCD admin permissions in namespace ${namespace}...`);
  try {
    runCommand(
      `kubectl create rolebinding ${appName}-argocd-admin ` +
      `--clusterrole=admin ` +
      `--serviceaccount=${argoCDNS}:${argoSA} ` +
      `-n ${namespace} --dry-run=client -o yaml | kubectl apply -f -`,
      { stdio: 'inherit' }
    );
  } catch (_) {}
}

async function deployArgoCD(appName, chartSubPath, extraValues = '') {
  const chartPath      = path.join(__dirname, '../.helm/argocd').replace(/\\/g, '/');
  const infraRepo      = process.env.INFRA_REGISTRY || '';
  const helmChartPath  = process.env.HELM_CHART_PATH || 'helmcharts/basic-app';
  const registry       = process.env.CONTAINER_REGISTRY || 'ghcr.io';
  const repository     = process.env.CONTAINER_REPOSITORY || 'tamfrost/basic-app';
  const argoCDNS       = process.env.ARGOCD_NAMESPACE || 'openshift-gitops';
  const appId          = process.env.AUTH_APP_ID;
  const installationId = process.env.AUTH_APP_INSTALLATION_ID;
  const privateKey     = getGitHubAppPrivateKey();
  const { namespace }  = getAppConfig();

  const tmpKeyFile = path.join(__dirname, '../.tmp-gh-app-key.pem');
  fs.writeFileSync(tmpKeyFile, privateKey, 'utf8');
  const tmpKeyFilePosix = tmpKeyFile.replace(/\\/g, '/');

  const tmpValuesFile = extraValues ? path.join(__dirname, '../.tmp-extra-values.yaml') : null;
  if (tmpValuesFile) fs.writeFileSync(tmpValuesFile, extraValues, 'utf8');
  const tmpValuesFilePosix = tmpValuesFile ? tmpValuesFile.replace(/\\/g, '/') : null;

  ensureNamespace(namespace);
  try {
    runCommand(`kubectl label namespace ${namespace} argocd.argoproj.io/managed-by=${argoCDNS} --overwrite`, { stdio: 'inherit' });
  } catch (_) {}



  try {
    runCommand(`kubectl delete secret ${appName}-infra-repo -n ${argoCDNS}`, { stdio: 'pipe' });
  } catch (_) {}

  try {
    runCommand(
      `helm template ${appName} "${chartPath}" ` +
      `--set appName="${appName}" ` +
      `--set argoCDNamespace="${argoCDNS}" ` +
      `--set targetNamespace="${namespace}" ` +
      `--set repository.url="${infraRepo}" ` +
      `--set repository.githubAppID="${appId}" ` +
      `--set repository.githubAppInstallationID="${installationId}" ` +
      `--set-file repository.githubAppPrivateKey="${tmpKeyFilePosix}" ` +
      `--set source.repoURL="${infraRepo}" ` +
      `--set source.targetRevision="HEAD" ` +
      `--set source.path="${helmChartPath}/${chartSubPath}" ` +
      `--set image.registry="${registry}" ` +
      `--set image.repository="${repository}" ` +
      (tmpValuesFilePosix ? `--set-file extraValues="${tmpValuesFilePosix}" ` : '') +
      `| kubectl apply -f -`,
      { stdio: 'inherit' }
    );
    if (process.env.ARGOCD_WEBHOOK_SECRET) {
      console.log('\nDeploying ArgoCD webhook secret...');
      const manifest =
        `apiVersion: v1\nkind: Secret\nmetadata:\n  name: argocd-secret\n  namespace: ${argoCDNS}\n` +
        `stringData:\n  webhook.github.secret: "${process.env.ARGOCD_WEBHOOK_SECRET}"\n`;
      const { execSync } = require('child_process');
      execSync(`kubectl apply --field-manager=basic-app -f -`, { input: manifest, stdio: ['pipe', 'inherit', 'inherit'] });
    }
  } finally {
    if (fs.existsSync(tmpKeyFile)) fs.unlinkSync(tmpKeyFile);
    if (tmpValuesFile && fs.existsSync(tmpValuesFile)) fs.unlinkSync(tmpValuesFile);
  }
}

function cleanupNamespace(namespace) {
  console.log(`\nCleaning up resources in namespace ${namespace}...`);
  for (const type of ['all', 'secret', 'configmap', 'serviceaccount', 'route', 'pvc', 'certificate']) {
    try { runCommand(`kubectl delete ${type} --all -n ${namespace} --ignore-not-found`, { stdio: 'pipe' }); } catch (_) {}
  }
  console.log('✓ Namespace resources removed');
}

function silentlyRemoveArgoCDApp(appName) {
  const argoCDNS = process.env.ARGOCD_NAMESPACE || 'openshift-gitops';
  try {
    runCommand(
      `kubectl patch application ${appName} -n ${argoCDNS} ` +
      `-p '{"spec":{"syncPolicy":null}}' --type merge`,
      { stdio: 'pipe' }
    );
    runCommand(
      `kubectl patch application ${appName} -n ${argoCDNS} ` +
      `-p '{"metadata":{"finalizers":["resources-finalizer.argocd.argoproj.io"]}}' --type merge`,
      { stdio: 'pipe' }
    );
    runCommand(`kubectl delete application ${appName} -n ${argoCDNS} --ignore-not-found`, { stdio: 'pipe' });
  } catch (_) {}
}

async function deleteArgoCD(appName) {
  const argoCDNS = process.env.ARGOCD_NAMESPACE || 'openshift-gitops';
  const ok = await confirm({ message: `Delete Argo CD application ${appName} and all its resources?`, default: false });
  if (!ok) { console.log('Cancelled.'); return; }

  console.log('\nDisabling auto-sync...');
  try {
    runCommand(
      `kubectl patch application ${appName} -n ${argoCDNS} ` +
      `-p '{"spec":{"syncPolicy":null}}' --type merge`,
      { stdio: 'pipe' }
    );
  } catch (_) {}

  console.log('Adding cascade finalizer...');
  try {
    runCommand(
      `kubectl patch application ${appName} -n ${argoCDNS} ` +
      `-p '{"metadata":{"finalizers":["resources-finalizer.argocd.argoproj.io"]}}' --type merge`,
      { stdio: 'pipe' }
    );
  } catch (_) {}

  runCommand(`kubectl delete application ${appName} -n ${argoCDNS} --ignore-not-found`, { stdio: 'inherit' });
  cleanupNamespace(getAppConfig().namespace);
  console.log('\n✓ Argo CD application and resources deleted');
}

async function deployAppArgoCD() {
  const { name: appName, namespace } = getAppConfig();
  console.log(`\nDeploying ${appName} via Argo CD...`);
  const extraLines = [`appName: "${appName}"`, `namespace: "${namespace}"`, ...appConfigExtraLines()];
  try {
    await deployArgoCD(appName, 'app', extraLines.join('\n'));
    console.log('\n✓ Argo CD application created');
  } catch (error) {
    console.error('\nDeploy failed:', error.message);
  }
}

async function deleteAppArgoCD() {
  const { name: appName } = getAppConfig();
  try { await deleteArgoCD(appName); } catch (error) { console.error('\nDelete failed:', error.message); }
}

async function deployAppX509ArgoCD() {
  const { name: appName, namespace, routeHost } = getAppConfig();
  console.log(`\nDeploying ${appName} (x509) via Argo CD...`);
  const nginxCa = ensureNginxCa();
  const acmeUrl        = nginxCa ? '-' : (process.env.ACME_DIRECTORY_URL || '-');
  const acmeIssuerName = (process.env.ACME_ISSUER_NAME && process.env.ACME_ISSUER_NAME !== '-') ? process.env.ACME_ISSUER_NAME : 'internal-ca';

  const extraLines = [
    `appName: "${appName}"`,
    `namespace: "${namespace}"`,
    `acmeDirectoryUrl: "${acmeUrl}"`,
    `acmeIssuerName: "${acmeIssuerName}"`,
    ...(routeHost ? [`route:\n  host: "${routeHost}"`] : []),
  ];
  if (nginxCa) {
    extraLines.push(`nginxCaCert: |`);
    nginxCa.cert.split('\n').forEach(l => extraLines.push(`  ${l}`));
    extraLines.push(`nginxCaKey: |`);
    nginxCa.key.split('\n').forEach(l => extraLines.push(`  ${l}`));
  }
  appConfigExtraLines().forEach(l => extraLines.push(l));
  try {
    await deployArgoCD(`${appName}-x509`, 'app-x509', extraLines.join('\n'));
    console.log('\n✓ Argo CD application created');
  } catch (error) {
    console.error('\nDeploy failed:', error.message);
  }
}

async function deleteAppX509ArgoCD() {
  const { name: appName } = getAppConfig();
  try { await deleteArgoCD(`${appName}-x509`); } catch (error) { console.error('\nDelete failed:', error.message); }
}

async function deployAppOAuth2ArgoCD() {
  const { name: appName, namespace, routeHost } = getAppConfig();
  console.log(`\nDeploying ${appName} (oauth2) via Argo CD...`);
  const nginxCa        = ensureNginxCa();
  const acmeUrl        = nginxCa ? '-' : (process.env.ACME_DIRECTORY_URL || '-');
  const acmeIssuerName = (process.env.ACME_ISSUER_NAME && process.env.ACME_ISSUER_NAME !== '-') ? process.env.ACME_ISSUER_NAME : 'internal-ca';

  const redirectUrl    = process.env.OAUTH2_REDIRECT_URL || (routeHost ? `https://${routeHost}/oauth2/callback` : '');
  const extraLines = [
    `appName: "${appName}"`,
    `namespace: "${namespace}"`,
    `acmeDirectoryUrl: "${acmeUrl}"`,
    `acmeIssuerName: "${acmeIssuerName}"`,
    ...(routeHost ? [`route:\n  host: "${routeHost}"`] : []),
    `oauth2Proxy:`,
    `  clientID: "${process.env.OAUTH2_CLIENT_ID || ''}"`,
    `  clientSecret: "${process.env.OAUTH2_CLIENT_SECRET || ''}"`,
    `  cookieSecret: "${process.env.OAUTH2_COOKIE_SECRET || ''}"`,
    `  oidcIssuerUrl: "${process.env.OAUTH2_OIDC_ISSUER_URL || ''}"`,
    `  redirectUrl: "${redirectUrl}"`,
    `  allowedGroups: "${process.env.OAUTH2_ALLOWED_GROUPS || '-'}"`,
  ];
  if (nginxCa) {
    extraLines.push(`nginxCaCert: |`);
    nginxCa.cert.split('\n').forEach(l => extraLines.push(`  ${l}`));
    extraLines.push(`nginxCaKey: |`);
    nginxCa.key.split('\n').forEach(l => extraLines.push(`  ${l}`));
  }
  appConfigExtraLines().forEach(l => extraLines.push(l));
  try {
    await deployArgoCD(`${appName}-oauth2`, 'app-oauth2', extraLines.join('\n'));
    console.log('\n✓ Argo CD application created');
  } catch (error) {
    console.error('\nDeploy failed:', error.message);
  }
}

async function deleteAppOAuth2ArgoCD() {
  const { name: appName } = getAppConfig();
  try { await deleteArgoCD(`${appName}-oauth2`); } catch (error) { console.error('\nDelete failed:', error.message); }
}

async function appOAuth2Menu() {
  const action = await select({
    message: 'App (oauth2):',
    choices: [
      { name: 'Deploy',            value: 'deploy'            },
      { name: 'Delete',            value: 'delete'            },
      { name: 'Deploy Argo CD',    value: 'deploy_argocd'     },
      { name: 'Delete Argo CD',    value: 'delete_argocd'     },
      { name: 'Back',              value: 'back'              },
    ]
  });
  if (action === 'deploy')         await deployAppOAuth2();
  if (action === 'delete')         await deleteAppOAuth2();
  if (action === 'deploy_argocd')  { grantArgoCDPermissions(); await deployAppOAuth2ArgoCD(); }
  if (action === 'delete_argocd')  await deleteAppOAuth2ArgoCD();
}

async function appX509Menu() {
  const action = await select({
    message: 'App (x509):',
    choices: [
      { name: 'Deploy',            value: 'deploy'            },
      { name: 'Delete',            value: 'delete'            },
      { name: 'Deploy Argo CD',    value: 'deploy_argocd'     },
      { name: 'Delete Argo CD',    value: 'delete_argocd'     },
      { name: 'Back',              value: 'back'              },
    ]
  });
  if (action === 'deploy')         await deployAppX509();
  if (action === 'delete')         await deleteAppX509();
  if (action === 'deploy_argocd')  { grantArgoCDPermissions(); await deployAppX509ArgoCD(); }
  if (action === 'delete_argocd')  await deleteAppX509ArgoCD();
}

async function appMenu() {
  const action = await select({
    message: 'App:',
    choices: [
      { name: 'Deploy',            value: 'deploy'            },
      { name: 'Delete',            value: 'delete'            },
      { name: 'Deploy Argo CD',    value: 'deploy_argocd'     },
      { name: 'Delete Argo CD',    value: 'delete_argocd'     },
      { name: 'Back',              value: 'back'              },
    ]
  });
  if (action === 'deploy')         await deployApp();
  if (action === 'delete')         await deleteApp();
  if (action === 'deploy_argocd')  { grantArgoCDPermissions(); await deployAppArgoCD(); }
  if (action === 'delete_argocd')  await deleteAppArgoCD();
}

async function checkKubectlContext() {
  try {
    console.log('\n=== Current kubectl Context ===\n');

    const current = runCommand('kubectl config current-context', { encoding: 'utf8' }).trim();
    console.log(`Context:   ${current}`);

    const view = runCommand(
      `kubectl config view --minify -o jsonpath="{.contexts[0].context.cluster}|{.contexts[0].context.user}|{.contexts[0].context.namespace}|{.clusters[0].cluster.server}"`,
      { encoding: 'utf8' }
    ).trim();

    const [cluster, user, namespace, server] = view.split('|');
    console.log(`Cluster:   ${cluster || '(unknown)'}`);
    console.log(`User:      ${user || '(unknown)'}`);
    console.log(`Namespace: ${namespace || 'default'}`);
    console.log(`Server:    ${server || '(unknown)'}`);

    try {
      const whoami = runCommand('kubectl auth whoami -o jsonpath="{.status.userInfo.username}" 2>$null', { encoding: 'utf8' }).trim();
      if (whoami) console.log(`Whoami:    ${whoami}`);
    } catch (_) {}

    console.log('\nAvailable contexts:');
    runCommand('kubectl config get-contexts', { stdio: 'inherit' });
  } catch (error) {
    console.error('\nError checking kubectl context:', error.message);
  }
}


async function main() {
  console.log('=== df-sim Tool ===\n');

  let exit = false;
  while (!exit) {
    const action = await select({
      message: 'What would you like to do?',
      choices: [
        { name: 'App', value: 'app' },
        { name: 'App (x509)', value: 'app_x509' },
        { name: 'App (oauth2)', value: 'app_oauth2' },
        { name: 'Check kubectl context', value: 'check_context' },
        { name: 'Get GitHub variables', value: 'get_variables' },
        { name: 'Exit', value: 'exit' }
      ]
    });

    reloadEnv();
    switch (action) {
      case 'app':
        await appMenu();
        console.log('\n');
        break;
      case 'app_x509':
        await appX509Menu();
        console.log('\n');
        break;
      case 'app_oauth2':
        await appOAuth2Menu();
        console.log('\n');
        break;
      case 'check_context':
        await checkKubectlContext();
        console.log('\n');
        break;
      case 'get_variables':
        await getGitHubVariables();
        console.log('\n');
        break;
      case 'exit':
        console.log('Goodbye!');
        exit = true;
        break;
    }
  }
}

main().catch(err => {
  if (err.name === 'ExitPromptError') process.exit(0);
  console.error(err);
});
