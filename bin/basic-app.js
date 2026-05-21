#!/usr/bin/env node

const { select, confirm } = require('@inquirer/prompts');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

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
    { iat: now - 60, exp: now + (10 * 60), iss: process.env.GITHUB_APP_ID },
    process.env.GITHUB_APP_PRIVATE_KEY,
    { algorithm: 'RS256' }
  );
}

async function getInstallationToken() {
  const response = await axiosInstance.post(
    `https://github.sys/api/v3/app/installations/${process.env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
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
    if (process.env.GITHUB_REPO_OWNER && process.env.GITHUB_REPO_NAME) {
      repoInfo = { owner: process.env.GITHUB_REPO_OWNER, repo: process.env.GITHUB_REPO_NAME };
      console.log(`Using repository from environment: ${repoInfo.owner}/${repoInfo.repo}`);
    } else {
      repoInfo = getRepoInfoFromGitConfig();
      if (repoInfo) console.log(`Using repository from git config: ${repoInfo.owner}/${repoInfo.repo}`);
    }

    if (!repoInfo) {
      console.error('Error: Could not determine repository info.');
      console.error('Either set GITHUB_REPO_OWNER and GITHUB_REPO_NAME in .env,');
      console.error('or ensure you are in a valid git repository with a GitHub remote.');
      return;
    }

    const { owner, repo } = repoInfo;
    console.log(`Fetching variables for ${owner}/${repo}...\n`);

    const repoVarsResponse = await axiosInstance.get(
      `https://github.sys/api/v3/repos/${owner}/${repo}/actions/variables`,
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
        `https://github.sys/api/v3/orgs/${owner}/actions/variables`,
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
  const registry = process.env.CONTAINER_REGISTRY || 'ghcr.io';
  const repository = process.env.CONTAINER_REPOSITORY || 'tamfrost/basic-app';
  const chartPath = path.join(__dirname, '../.helm/app');
  const appName = 'basic-app';
  const namespace = 'basic-app';

  console.log(`\nDeploying ${appName} from ${registry}/${repository}...`);
  try {
    runCommand(
      `helm upgrade --install ${appName} "${chartPath}" ` +
      `--create-namespace --namespace ${namespace} ` +
      `--set image.registry="${registry}" ` +
      `--set image.repository="${repository}" ` +
      `--set route.enabled=true`,
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
  const appName = 'basic-app';
  const namespace = 'basic-app';

  const ok = await confirm({ message: `Delete ${appName} from namespace ${namespace}?`, default: false });
  if (!ok) { console.log('Cancelled.'); return; }

  try {
    runCommand(`helm uninstall ${appName} --namespace ${namespace}`, { stdio: 'inherit' });
    console.log(`\n✓ ${appName} deleted`);
  } catch (error) {
    console.error('\nDelete failed:', error.message);
  }
}

async function deployAppX509() {
  const registry = process.env.CONTAINER_REGISTRY || 'ghcr.io';
  const repository = process.env.CONTAINER_REPOSITORY || 'tamfrost/basic-app';
  const chartPath = path.join(__dirname, '../.helm/app-x509');
  const caCertPath = path.resolve(__dirname, '..', process.env.CLIENT_CERT_FILE || 'certs/client/ca-cert.pem').replace(/\\/g, '/');
  const releaseName = 'basic-app';
  const namespace = 'basic-app';

  console.log(`\nDeploying ${releaseName} with x509 proxy...`);
  try {
    runCommand(
      `helm upgrade --install ${releaseName} "${chartPath}" ` +
      `--create-namespace --namespace ${namespace} ` +
      `--set image.registry="${registry}" ` +
      `--set image.repository="${repository}" ` +
      `--set-file caCert="${caCertPath}"`,
      { stdio: 'inherit' }
    );
    console.log(`\n✓ ${releaseName} deployed`);
    try {
      const route = runCommand(`kubectl get route ${releaseName} -n ${namespace} -o jsonpath="{.spec.host}" 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (route) console.log(`🌐 https://${route}  (requires client cert)`);
    } catch (_) {}
  } catch (error) {
    console.error('\nDeploy failed:', error.message);
  }
}

async function deleteAppX509() {
  const releaseName = 'basic-app';
  const namespace = 'basic-app';

  const ok = await confirm({ message: `Delete ${releaseName} from namespace ${namespace}?`, default: false });
  if (!ok) { console.log('Cancelled.'); return; }

  try {
    runCommand(`helm uninstall ${releaseName} --namespace ${namespace}`, { stdio: 'inherit' });
    console.log(`\n✓ ${releaseName} deleted`);
  } catch (error) {
    console.error('\nDelete failed:', error.message);
  }
}

async function appX509Menu() {
  const action = await select({
    message: 'App (x509):',
    choices: [
      { name: 'Deploy', value: 'deploy' },
      { name: 'Delete', value: 'delete' },
      { name: 'Back', value: 'back' },
    ]
  });
  if (action === 'deploy') await deployAppX509();
  if (action === 'delete') await deleteAppX509();
}

async function appMenu() {
  const action = await select({
    message: 'App:',
    choices: [
      { name: 'Deploy', value: 'deploy' },
      { name: 'Delete', value: 'delete' },
      { name: 'Back', value: 'back' },
    ]
  });
  if (action === 'deploy') await deployApp();
  if (action === 'delete') await deleteApp();
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
        { name: 'Check kubectl context', value: 'check_context' },
        { name: 'Get GitHub variables', value: 'get_variables' },
        { name: 'Exit', value: 'exit' }
      ]
    });

    switch (action) {
      case 'app':
        await appMenu();
        console.log('\n');
        break;
      case 'app_x509':
        await appX509Menu();
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

main().catch(console.error);
