#!/usr/bin/env node

const inquirer = require('inquirer');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const path = require('path');

// Load .env file from project root (one level up from bin/)
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// Helper to run commands with proper shell on Windows
function runCommand(command, options = {}) {
  const { execSync } = require('child_process');
  const isWindows = process.platform === 'win32';
  
  const defaultOptions = {
    shell: isWindows ? 'powershell.exe' : true,
    ...options
  };
  
  // Replace Unix-style error redirection with PowerShell equivalent
  if (isWindows && command.includes('2>/dev/null')) {
    command = command.replace(/2>\/dev\/null/g, '2>$null');
  }
  
  return execSync(command, defaultOptions);
}

// Normalize GitHub App private key from .env
function getGitHubAppPrivateKey() {
  let key = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!key) {
    throw new Error('GITHUB_APP_PRIVATE_KEY not found in .env file');
  }
  
  // Strip surrounding quotes if present
  key = key.replace(/^["']|["']$/g, '');
  
  // Replace literal \n with actual newlines (in case they were escaped in .env)
  key = key.replace(/\\n/g, '\n');
  
  // Remove any carriage returns
  key = key.replace(/\r/g, '');
  
  return key;
}

// Load corporate CA certificates
const certPath = path.join(__dirname, '../certs/canna-ca-bundle.crt');
let ca = undefined;
if (fs.existsSync(certPath)) {
  ca = fs.readFileSync(certPath);
  console.log(`Loaded CA certificates from: ${certPath}\n`);
}

// Configure proxy
let proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
if (proxy) {
  proxy = proxy.replace(/\/$/, '');
  console.log(`Using proxy: ${proxy}\n`);
}

// Create axios instance with proxy and CA certs
const agentOptions = {};
if (ca) {
  agentOptions.ca = ca;
}

let httpsAgent = undefined;
if (proxy) {
  httpsAgent = new HttpsProxyAgent(proxy, agentOptions);
}

const axiosInstance = axios.create({
  httpsAgent: httpsAgent,
  timeout: 60000,
  headers: {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
});

// Helper function to create GitHub App JWT
function createGitHubAppJWT() {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60, // Issued 60 seconds in the past to allow for clock drift
    exp: now + (10 * 60), // Expires in 10 minutes
    iss: process.env.GITHUB_APP_ID,
  };
  return jwt.sign(payload, process.env.GITHUB_APP_PRIVATE_KEY, { algorithm: 'RS256' });
}

// Helper function to get installation access token
async function getInstallationToken() {
  const appJWT = createGitHubAppJWT();
  
  const response = await axiosInstance.post(
    `https://api.github.com/app/installations/${process.env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
    {},
    {
      headers: {
        'Authorization': `Bearer ${appJWT}`,
      }
    }
  );
  
  return response.data.token;
}

// Helper function to extract repo info using git commands
function getRepoInfoFromGitConfig() {
  const { execSync } = require('child_process');
  
  try {
    // Get remote URL using git command - works with any URL format
    const remoteUrl = execSync('git remote get-url origin', { 
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8' 
    }).trim();
    
    // Parse GitHub URLs (HTTPS, SSH, or custom hosts)
    // Handles: https://github.com/owner/repo.git
    //          https://user:pass@github.com/owner/repo.git
    //          git@github.com:owner/repo.git
    //          git@github-custom:owner/repo.git
    const match = remoteUrl.match(/(?:https?:\/\/(?:[^@\/]+@)?[^\/]*github[^\/]*\/|git@[^:]+:)([^\/]+)\/(.+?)(?:\.git)?$/);
    
    if (match) {
      return {
        owner: match[1],
        repo: match[2]
      };
    }
    
    return null;
  } catch (error) {
    // Git command failed or not in a git repo
    return null;
  }
}

async function getGitHubVariables() {
  try {
    console.log('Authenticating with GitHub App...');
    const token = await getInstallationToken();
    console.log('✓ Successfully authenticated\n');

    // Get repository info from env vars first, then fall back to git config
    let repoInfo;
    
    if (process.env.GITHUB_REPO_OWNER && process.env.GITHUB_REPO_NAME) {
      repoInfo = {
        owner: process.env.GITHUB_REPO_OWNER,
        repo: process.env.GITHUB_REPO_NAME
      };
      console.log(`Using repository from environment: ${repoInfo.owner}/${repoInfo.repo}`);
    } else {
      repoInfo = getRepoInfoFromGitConfig();
      if (repoInfo) {
        console.log(`Using repository from git config: ${repoInfo.owner}/${repoInfo.repo}`);
      }
    }
    
    if (!repoInfo) {
      console.error('Error: Could not determine repository info.');
      console.error('Either set GITHUB_REPO_OWNER and GITHUB_REPO_NAME in .env,');
      console.error('or ensure you are in a valid git repository with a GitHub remote.');
      return;
    }

    const { owner, repo } = repoInfo;
    console.log(`Fetching variables for ${owner}/${repo}...\n`);

    // Get repository variables
    const repoVarsResponse = await axiosInstance.get(
      `https://api.github.com/repos/${owner}/${repo}/actions/variables`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
        }
      }
    );

    console.log('=== Repository Variables ===');
    if (repoVarsResponse.data.variables && repoVarsResponse.data.variables.length > 0) {
      repoVarsResponse.data.variables.forEach(variable => {
        console.log(`${variable.name}: ${variable.value}`);
      });
    } else {
      console.log('No repository variables found.');
    }

    // Get organization variables (if applicable)
    try {
      const orgVarsResponse = await axiosInstance.get(
        `https://api.github.com/orgs/${owner}/actions/variables`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
          }
        }
      );

      console.log('\n=== Organization Variables ===');
      if (orgVarsResponse.data.variables && orgVarsResponse.data.variables.length > 0) {
        orgVarsResponse.data.variables.forEach(variable => {
          console.log(`${variable.name}: ${variable.value}`);
        });
      } else {
        console.log('No organization variables found.');
      }
    } catch (error) {
      console.log('\n=== Organization Variables ===');
      if (error.response && error.response.status === 404) {
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
        console.error('\nTo fix this:');
        console.error('1. Go to GitHub App settings: https://github.com/settings/apps');
        console.error('2. Select your app');
        console.error('3. Go to "Permissions & events"');
        console.error('4. Under "Repository permissions", set "Variables" to "Read-only" or "Read and write"');
        console.error('5. Save and accept the permission change in the repository');
      }
    }
  }
}

async function deployApp() {
  try {
    const { execSync } = require('child_process');

    const appName = process.env.APP_NAME || 'df-sim';
    const namespace = process.env.APP_NAMESPACE || 'df-sim';

    // Validate required environment variables
    const registry = process.env.CONTAINER_REGISTRY;
    const repository = process.env.CONTAINER_REPOSITORY;
    const username = process.env.CONTAINER_REGISTRY_USERNAME;

    if (!registry || !repository || !username) {
      console.error('\n❌ Missing required environment variables in .env file:');
      if (!registry) console.error('  - CONTAINER_REGISTRY');
      if (!repository) console.error('  - CONTAINER_REPOSITORY');
      if (!username) console.error('  - CONTAINER_REGISTRY_USERNAME');
      console.error('\nPlease ensure these are set in your .env file.');
      return;
    }

    const variant = await inquirer.prompt([
      {
        type: 'list',
        name: 'mode',
        message: 'Deployment variant:',
        choices: [
          { name: 'With oauth2-proxy sidecar (routed via nginx mTLS proxy)', value: 'with_oauth2' },
          { name: 'Without oauth2-proxy (direct OpenShift Route to app, no auth)', value: 'no_oauth2' }
        ],
        default: 'with_oauth2'
      }
    ]);
    const withOAuth2Proxy = variant.mode === 'with_oauth2';

    // When oauth2-proxy is disabled, expose the app directly via an OpenShift Route.
    // When enabled, leave routing to the separate nginx infra chart (current behaviour).
    const variantFlags = withOAuth2Proxy
      ? ''
      : `--set oauth2Proxy.enabled=false --set route.enabled=true `;

    console.log(`\nUsing values from .env:`);
    console.log(`  Registry: ${registry}`);
    console.log(`  Repository: ${repository}`);
    console.log(`  Username: ${username}`);
    console.log(`  Variant:  ${withOAuth2Proxy ? 'with oauth2-proxy' : 'no oauth2-proxy (direct route)'}`);

    console.log(`\nChecking if ${appName} is already deployed...`);

    try {
      const releases = runCommand(`helm list -n ${namespace} -o json`, { encoding: 'utf8' });
      const releaseList = JSON.parse(releases);

      const release = releaseList.find(r => r.name === appName);
      if (release) {
        console.log(`⚠️  ${appName} is already deployed (status: ${release.status}, revision: ${release.revision})`);

        const confirm = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'upgrade',
            message: 'Do you want to upgrade the existing deployment?',
            default: false
          }
        ]);

        if (!confirm.upgrade) {
          console.log('Deploy cancelled.');
          return;
        }

        console.log(`\nUpgrading ${appName} deployment...`);
        const chartPath = path.join(__dirname, '../.helm/app');

        execSync(
          `helm upgrade ${appName} "${chartPath}" ` +
          `--namespace ${namespace} ` +
          variantFlags +
          `--set image.registry="${registry}" ` +
          `--set image.repository="${repository}" ` +
          `--set githubUsername="${username}"`,
          { stdio: 'inherit' }
        );
        console.log(`\n✓ ${appName} successfully upgraded`);
        return;
      }

    } catch (error) {
      // No release found, proceed with install attempt
    }

    console.log(`\nDeploying ${appName}...`);
    const chartPath = path.join(__dirname, '../.helm/app');

    execSync(
      `helm install ${appName} "${chartPath}" ` +
      `--create-namespace ` +
      `--namespace ${namespace} ` +
      variantFlags +
      `--set image.registry="${registry}" ` +
      `--set image.repository="${repository}" ` +
      `--set githubUsername="${username}"`,
      { stdio: 'inherit' }
    );

    console.log(`\n✓ ${appName} successfully deployed`);

    if (withOAuth2Proxy) {
      console.log('\nℹ️  oauth2-proxy variant — routing handled by the nginx infra chart.');
      console.log('   Deploy/upgrade nginx via the "Deploy nginx proxy (mTLS)" menu item if needed.');
      return;
    }

    console.log('\nGetting route information...');
    try {
      const route = runCommand(`kubectl get route ${appName} -n ${namespace} -o jsonpath="{.spec.host}"`, { encoding: 'utf8' });
      if (route) {
        console.log(`\n🌐 Access the application at: https://${route}`);
        console.log('   (no auth — direct route to app)');
      }
    } catch (error) {
      console.log('Could not retrieve route information');
    }
    
  } catch (error) {
    if (error.message && error.message.includes('cannot be imported into the current release')) {
      console.error('\n❌ Deployment failed: Resources already exist but are not managed by Helm.');
      console.error('\nThis usually happens when ArgoCD or another tool has deployed the application.');
      console.error('\nSuggested actions:');
      console.error('  1. Use "Remove ArgoCD application" if managed by ArgoCD');
      console.error('  2. Use "Undeploy application" to clean up resources');
      console.error('  3. Or use ArgoCD to manage the deployment instead of direct Helm');
    } else {
      console.error('\nError during deploy:', error.message);
    }
  }
}

async function undeployApp() {
  try {
    const { execSync } = require('child_process');
    
    const appName = process.env.APP_NAME || 'df-sim';
    const namespace = process.env.APP_NAMESPACE || 'df-sim';
    
    console.log(`\nChecking if ${appName} is deployed...`);
    
    try {
      const releases = runCommand(`helm list -n ${namespace} -o json`, { encoding: 'utf8' });
      const releaseList = JSON.parse(releases);
      
      if (releaseList.length === 0) {
        console.log(`⚠️  ${appName} is not currently deployed.`);
        return;
      }
      
      const release = releaseList.find(r => r.name === appName);
      if (!release) {
        console.log(`⚠️  ${appName} release not found.`);
        return;
      }
      
      console.log(`Found ${appName} deployment (status: ${release.status}, revision: ${release.revision})`);
      
      const confirm = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'proceed',
          message: `Are you sure you want to undeploy ${appName}?`,
          default: false
        }
      ]);
      
      if (!confirm.proceed) {
        console.log('Undeploy cancelled.');
        return;
      }
      
      console.log(`\nUndeploying ${appName}...`);
      runCommand(`helm uninstall ${appName} --namespace ${namespace}`, { stdio: 'inherit' });
      console.log(`\n✓ ${appName} successfully undeployed`);
      
    } catch (error) {
      if (error.message.includes('not found')) {
        console.log(`⚠️  ${appName} is not currently deployed.`);
      } else {
        throw error;
      }
    }
    
  } catch (error) {
    console.error('\nError during undeploy:', error.message);
  }
}

async function deployNginx() {
  try {
    const { execSync } = require('child_process');
    
    const nginxName = 'df-sim-nginx';
    const namespace = process.env.APP_NAMESPACE || 'df-sim';
    
    console.log(`\nChecking if ${nginxName} is already deployed...`);
    
    try {
      const releases = runCommand(`helm list -n ${namespace} -o json`, { encoding: 'utf8' });
      const releaseList = JSON.parse(releases);
      
      const release = releaseList.find(r => r.name === nginxName);
      if (release) {
        console.log(`⚠️  ${nginxName} is already deployed (status: ${release.status}, revision: ${release.revision})`);
        
        const confirm = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'upgrade',
            message: 'Do you want to upgrade the existing nginx proxy?',
            default: false
          }
        ]);
        
        if (!confirm.upgrade) {
          console.log('Deploy cancelled.');
          return;
        }
        
        console.log(`\nUpgrading ${nginxName}...`);
        const chartPath = path.join(__dirname, '../.helm/infra');
        
        execSync(
          `helm upgrade ${nginxName} "${chartPath}" ` +
          `--namespace ${namespace}`,
          { stdio: 'inherit' }
        );
        console.log(`\n✓ ${nginxName} successfully upgraded`);
        return;
      }
      
    } catch (error) {
      // No release found, proceed with install
    }
    
    console.log(`\nDeploying ${nginxName}...`);
    const chartPath = path.join(__dirname, '../.helm/infra');
    
    execSync(
      `helm install ${nginxName} "${chartPath}" ` +
      `--create-namespace ` +
      `--namespace ${namespace}`,
      { stdio: 'inherit' }
    );
    
    console.log(`\n✓ ${nginxName} successfully deployed`);
    console.log('\nGetting route information...');
    
    try {
      const route = runCommand(`kubectl get route df-sim-nginx-nginx -n ${namespace} -o jsonpath="{.spec.host}"`, { encoding: 'utf8' });
      if (route) {
        console.log(`\n🔒 Application secured with dual authentication:`);
        console.log(`   1. Client certificate (nginx layer)`);
        console.log(`   2. OAuth2/Keycloak (application layer)`);
        console.log(`\n🌐 Access: https://${route}`);
        console.log(`\n⚠️  Requirements:`);
        console.log(`   - Valid client certificate (df-sim-client)`);
        console.log(`   - Keycloak credentials for realm 'master'`);
      }
    } catch (error) {
      console.log('Could not retrieve route information');
    }
    
  } catch (error) {
    console.error('\nError deploying nginx:', error.message);
  }
}

async function removeNginx() {
  try {
    const { execSync } = require('child_process');
    
    const nginxName = 'df-sim-nginx';
    const namespace = process.env.APP_NAMESPACE || 'df-sim';
    
    console.log(`\nChecking if ${nginxName} is deployed...`);
    
    try {
      const releases = runCommand(`helm list -n ${namespace} -o json`, { encoding: 'utf8' });
      const releaseList = JSON.parse(releases);
      
      const release = releaseList.find(r => r.name === nginxName);
      if (!release) {
        console.log(`⚠️  ${nginxName} is not currently deployed.`);
        return;
      }
      
      console.log(`Found ${nginxName} (status: ${release.status}, revision: ${release.revision})`);
      
      const confirm = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'proceed',
          message: `Are you sure you want to remove ${nginxName}?`,
          default: false
        }
      ]);
      
      if (!confirm.proceed) {
        console.log('Remove cancelled.');
        return;
      }
      
      console.log(`\nRemoving ${nginxName}...`);
      runCommand(`helm uninstall ${nginxName} --namespace ${namespace}`, { stdio: 'inherit' });
      console.log(`\n✓ ${nginxName} successfully removed`);
      
    } catch (error) {
      if (error.message.includes('not found')) {
        console.log(`⚠️  ${nginxName} is not currently deployed.`);
      } else {
        throw error;
      }
    }
    
  } catch (error) {
    console.error('\nError removing nginx:', error.message);
  }
}

async function deployKeycloak() {
  try {
    const { execSync } = require('child_process');

    const releaseName = 'df-sim-keycloak';
    const namespace = process.env.KEYCLOAK_NAMESPACE || 'keycloak';

    // Preflight: detect operator-managed Keycloak CR in this namespace and offer
    // to delete it before we deploy our custom instance.
    console.log(`\nChecking for operator-managed Keycloak CRs in namespace ${namespace}...`);
    try {
      const existing = runCommand(
        `kubectl get keycloak -n ${namespace} -o jsonpath="{.items[*].metadata.name}" 2>$null`,
        { encoding: 'utf8' }
      ).trim();

      if (existing && existing.length > 0) {
        console.log(`⚠️  Found operator-managed Keycloak CR(s): ${existing}`);
        console.log('   The operator will fight our custom Deployment if left in place.');

        const confirm = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'remove',
            message: 'Delete the operator-managed Keycloak CR(s) now? (operator itself is left alone)',
            default: false
          }
        ]);

        if (!confirm.remove) {
          console.log('Deploy cancelled — resolve the operator-managed instance first.');
          return;
        }

        for (const crd of ['keycloak', 'keycloakrealmimport']) {
          try {
            runCommand(`kubectl delete ${crd} --all -n ${namespace}`, { stdio: 'inherit' });
          } catch (_) {
            // CRD may not be installed; ignore
          }
        }
        console.log('✓ Operator-managed Keycloak resources removed');
      } else {
        console.log('✓ No operator-managed Keycloak CRs found');
      }
    } catch (error) {
      // `kubectl get keycloak` fails if CRD isn't installed — that's fine
      console.log('✓ Keycloak CRD not present (no operator install detected)');
    }

    console.log(`\nChecking if ${releaseName} is already deployed...`);

    try {
      const releases = runCommand(`helm list -n ${namespace} -o json`, { encoding: 'utf8' });
      const releaseList = JSON.parse(releases);
      const release = releaseList.find(r => r.name === releaseName);

      if (release) {
        console.log(`⚠️  ${releaseName} is already deployed (status: ${release.status}, revision: ${release.revision})`);

        const confirm = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'upgrade',
            message: 'Upgrade the existing custom Keycloak deployment?',
            default: false
          }
        ]);

        if (!confirm.upgrade) {
          console.log('Deploy cancelled.');
          return;
        }

        console.log(`\nUpgrading ${releaseName}...`);
        const chartPath = path.join(__dirname, '../.helm/keycloak');

        execSync(
          `helm upgrade ${releaseName} "${chartPath}" ` +
          `--namespace ${namespace}`,
          { stdio: 'inherit' }
        );
        console.log(`\n✓ ${releaseName} successfully upgraded`);
        return;
      }
    } catch (error) {
      // No release found, proceed with install
    }

    console.log(`\nDeploying ${releaseName}...`);
    const chartPath = path.join(__dirname, '../.helm/keycloak');

    execSync(
      `helm install ${releaseName} "${chartPath}" ` +
      `--create-namespace ` +
      `--namespace ${namespace}`,
      { stdio: 'inherit' }
    );

    console.log(`\n✓ ${releaseName} successfully deployed`);
    console.log('\nGetting route information...');

    try {
      const route = runCommand(
        `kubectl get route ${releaseName}-keycloak -n ${namespace} -o jsonpath="{.spec.host}"`,
        { encoding: 'utf8' }
      ).trim();
      if (route) {
        console.log(`\n🔐 Custom Keycloak with X509 client-cert auth:`);
        console.log(`   Realm:  df-sim`);
        console.log(`   Route:  https://${route}/realms/df-sim`);
        console.log(`\n⚠️  Update oauth2-proxy oidcIssuerUrl to point at the df-sim realm`);
        console.log(`   (already done in .helm/app/values.yaml — re-deploy the app to pick it up)`);
      }
    } catch (error) {
      console.log('Could not retrieve route information');
    }

  } catch (error) {
    console.error('\nError deploying Keycloak:', error.message);
  }
}

async function removeKeycloak() {
  try {
    const { execSync } = require('child_process');

    const releaseName = 'df-sim-keycloak';
    const namespace = process.env.KEYCLOAK_NAMESPACE || 'keycloak';

    console.log(`\nChecking if ${releaseName} is deployed...`);

    try {
      const releases = runCommand(`helm list -n ${namespace} -o json`, { encoding: 'utf8' });
      const releaseList = JSON.parse(releases);
      const release = releaseList.find(r => r.name === releaseName);

      if (!release) {
        console.log(`⚠️  ${releaseName} is not currently deployed.`);
        return;
      }

      console.log(`Found ${releaseName} (status: ${release.status}, revision: ${release.revision})`);

      const confirm = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'proceed',
          message: `Remove ${releaseName}? (Helm release only — operator/subscription untouched)`,
          default: false
        }
      ]);

      if (!confirm.proceed) {
        console.log('Remove cancelled.');
        return;
      }

      console.log(`\nRemoving ${releaseName}...`);
      runCommand(`helm uninstall ${releaseName} --namespace ${namespace}`, { stdio: 'inherit' });
      console.log(`\n✓ ${releaseName} successfully removed`);

    } catch (error) {
      if (error.message.includes('not found')) {
        console.log(`⚠️  ${releaseName} is not currently deployed.`);
      } else {
        throw error;
      }
    }

  } catch (error) {
    console.error('\nError removing Keycloak:', error.message);
  }
}

async function removeArgoCDApp() {
  try {
    const { execSync } = require('child_process');
    
    const appName = process.env.APP_NAME || 'df-sim';
    const argoCDNamespace = process.env.ARGOCD_NAMESPACE || 'openshift-gitops';
    const targetNamespace = process.env.APP_NAMESPACE || 'df-sim';
    
    console.log('\nChecking if ArgoCD application exists...');
    
    try {
      const app = runCommand(`kubectl get application ${appName} -n ${argoCDNamespace} -o json 2>/dev/null`, { encoding: 'utf8' });
      const appData = JSON.parse(app);
      
      if (!appData || !appData.metadata) {
        console.log(`⚠️  ArgoCD application ${appName} not found.`);
        return;
      }
      
      console.log(`Found ArgoCD application: ${appName}`);
      console.log(`Sync Status: ${appData.status?.sync?.status || 'Unknown'}`);
      console.log(`Health Status: ${appData.status?.health?.status || 'Unknown'}`);
      
      const confirm = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'proceed',
          message: `Remove ArgoCD application and delete all resources in ${targetNamespace}?`,
          default: false
        }
      ]);
      
      if (!confirm.proceed) {
        console.log('\nRemove cancelled.');
        return;
      }
      
      console.log('\nRemoving ArgoCD application...');
      runCommand(`kubectl delete application ${appName} -n ${argoCDNamespace}`, { stdio: 'inherit' });
      console.log('✓ ArgoCD application removed');
      
      console.log(`\nDeleting all resources in namespace ${targetNamespace}...`);
      try {
        runCommand(`kubectl delete all --all -n ${targetNamespace}`, { stdio: 'inherit' });
        runCommand(`kubectl delete serviceaccount --all -n ${targetNamespace} 2>/dev/null`, { stdio: 'pipe' });
        runCommand(`kubectl delete configmap --all -n ${targetNamespace} 2>/dev/null`, { stdio: 'pipe' });
        runCommand(`kubectl delete secret --all -n ${targetNamespace} 2>/dev/null`, { stdio: 'pipe' });
        runCommand(`kubectl delete route --all -n ${targetNamespace} 2>/dev/null`, { stdio: 'pipe' });
        console.log(`\n✓ All resources removed from ${targetNamespace} namespace`);
      } catch (error) {
        console.log('✓ Resources cleaned up');
      }
      
    } catch (error) {
      if (error.message.includes('not found') || error.message.includes('NotFound')) {
        console.log(`⚠️  ArgoCD application ${appName} not found.`);
      } else {
        throw error;
      }
    }
    
  } catch (error) {
    console.error('\nError removing ArgoCD application:', error.message);
  }
}

async function deployArgoCDApp() {
  try {
    const { execSync } = require('child_process');
    
    const appName = process.env.APP_NAME || 'df-sim';
    const argoCDNamespace = process.env.ARGOCD_NAMESPACE || 'openshift-gitops';
    const targetNamespace = process.env.APP_NAMESPACE || 'df-sim';
    const infraRepo = process.env.INFRA_REGISTRY;
    const helmChartPath = process.env.HELM_CHART_PATH;
    const registry = process.env.CONTAINER_REGISTRY;
    const repository = process.env.CONTAINER_REPOSITORY;
    const githubAppId = process.env.GITHUB_APP_ID;
    const githubAppInstallationId = process.env.GITHUB_APP_INSTALLATION_ID;
    
    // Normalize the private key (strip quotes, handle literal \n)
    const githubAppPrivateKey = getGitHubAppPrivateKey();
    
    console.log('\nChecking if ArgoCD application already exists...');
    
    try {
      const app = runCommand(`kubectl get application ${appName} -n ${argoCDNamespace} -o json 2>/dev/null`, { encoding: 'utf8' });
      const appData = JSON.parse(app);
      
      if (appData && appData.metadata) {
        console.log(`⚠️  ArgoCD application ${appName} already exists`);
        console.log(`Sync Status: ${appData.status?.sync?.status || 'Unknown'}`);
        console.log(`Health Status: ${appData.status?.health?.status || 'Unknown'}`);
        
        const confirm = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'reapply',
            message: 'Do you want to reapply the ArgoCD application?',
            default: false
          }
        ]);
        
        if (!confirm.reapply) {
          console.log('Deploy cancelled.');
          return;
        }
      }
    } catch (error) {
      // Application doesn't exist, proceed with creation
    }
    
    const argoCDChartPath = path.join(__dirname, '../.helm/argocd');
    
    // Write private key to temporary file for helm --set-file
    const tmpKeyFile = path.join(__dirname, '../.tmp-gh-app-key.pem');
    fs.writeFileSync(tmpKeyFile, githubAppPrivateKey, 'utf8');
    
    // Convert path to forward slashes for PowerShell compatibility
    const tmpKeyFilePosix = tmpKeyFile.replace(/\\/g, '/');
    const argoCDChartPathPosix = argoCDChartPath.replace(/\\/g, '/');
    
    // Delete old secret to avoid duplicate fields
    console.log('\nCleaning up old secret...');
    try {
      runCommand(`kubectl delete secret ${appName}-infra-repo -n ${argoCDNamespace}`, { stdio: 'pipe' });
      console.log('✓ Old secret deleted');
    } catch (error) {
      // Secret doesn't exist, that's fine
    }
    
    console.log('\nDeploying ArgoCD manifests with values from .env...');
    try {
      runCommand(
        `helm template ${appName} "${argoCDChartPathPosix}" ` +
        `--set appName="${appName}" ` +
        `--set argoCDNamespace="${argoCDNamespace}" ` +
        `--set targetNamespace="${targetNamespace}" ` +
        `--set repository.url="${infraRepo}" ` +
        `--set repository.githubAppID="${githubAppId}" ` +
        `--set repository.githubAppInstallationID="${githubAppInstallationId}" ` +
        `--set-file repository.githubAppPrivateKey="${tmpKeyFilePosix}" ` +
        `--set source.repoURL="${infraRepo}" ` +
        `--set source.targetRevision="HEAD" ` +
        `--set source.path="${helmChartPath}" ` +
        `--set image.registry="${registry}" ` +
        `--set image.repository="${repository}" ` +
        `| kubectl apply -f -`,
        { stdio: 'inherit' }
      );
    } finally {
      // Clean up temp file
      if (fs.existsSync(tmpKeyFile)) {
        fs.unlinkSync(tmpKeyFile);
      }
    }
    console.log('\n✓ ArgoCD application successfully deployed');
    
    console.log(`\nWaiting for application to sync...`);
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const namespace = process.env.APP_NAMESPACE || 'df-sim';
    
    try {
      const app = runCommand(`kubectl get application ${appName} -n ${argoCDNamespace} -o json`, { encoding: 'utf8' });
      const appData = JSON.parse(app);
      console.log(`\nApplication Status:`);
      console.log(`  Sync Status: ${appData.status?.sync?.status || 'Unknown'}`);
      console.log(`  Health Status: ${appData.status?.health?.status || 'Unknown'}`);
      
      if (appData.status?.sync?.status === 'Synced') {
        console.log('\n✓ Application is synced and ready');
      } else {
        console.log('\n⏳ Application will sync automatically in a few moments.');
      }
    } catch (error) {
      console.log('\nCould not retrieve application status');
    }
    
    // Always try to get route URL after deployment
    console.log('\nChecking for route...');
    try {
      const route = runCommand(`kubectl get route ${appName} -n ${namespace} -o jsonpath="{.spec.host}" 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (route && route.length > 0) {
        console.log(`🌐 Access the application at: https://${route}`);
      } else {
        console.log(`Route not yet available. Check status with: kubectl get route ${appName} -n ${namespace}`);
      }
    } catch (error) {
      console.log(`Route not yet available. Check status with: kubectl get route ${appName} -n ${namespace}`);
    }
    
  } catch (error) {
    console.error('\nError deploying ArgoCD application:', error.message);
  }
}

async function getPasswords() {
  try {
    const { execSync } = require('child_process');
    
    console.log('\n=== Cluster Credentials ===\n');
    
    // Try to get kubeadmin password
    console.log('Kubeadmin Password:');
    try {
      // Try CRC kubeadmin password file location
      const kubeadminPass = execSync('cat ~/.crc/machines/crc/kubeadmin-password 2>/dev/null || echo "Not found in ~/.crc/machines/crc/kubeadmin-password"', { encoding: 'utf8', shell: '/bin/bash' }).trim();
      console.log(`  ${kubeadminPass}`);
    } catch (error) {
      console.log('  Could not retrieve kubeadmin password');
    }
    
    console.log('\nArgoCD Admin Password:');
    const argoCDNamespace = process.env.ARGOCD_NAMESPACE || 'openshift-gitops';
    
    try {
      // Try to get ArgoCD admin password from secret
      const argoCDPass = execSync(
        `kubectl get secret openshift-gitops-cluster -n ${argoCDNamespace} -o go-template='{{index .data "admin.password"}}' 2>/dev/null | base64 -d || ` +
        `kubectl get secret argocd-initial-admin-secret -n ${argoCDNamespace} -o jsonpath="{.data.password}" 2>/dev/null | base64 -d || ` +
        `echo "Not found"`,
        { encoding: 'utf8', shell: '/bin/bash' }
      ).trim();
      console.log(`  ${argoCDPass}`);
      
      if (argoCDPass && argoCDPass !== 'Not found') {
        // Try to get ArgoCD route
        try {
          const argoCDRoute = runCommand(`kubectl get route openshift-gitops-server -n ${argoCDNamespace} -o jsonpath="{.spec.host}" 2>/dev/null`, { encoding: 'utf8' }).trim();
          if (argoCDRoute) {
            console.log(`\nArgoCD URL: https://${argoCDRoute}`);
            console.log(`Username: admin`);
          }
        } catch (error) {
          // Route not found
        }
      }
    } catch (error) {
      console.log('  Could not retrieve ArgoCD password');
    }
    
  } catch (error) {
    console.error('\nError retrieving passwords:', error.message);
  }
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
    } catch (_) {
      // older kubectl without `auth whoami` — ignore
    }

    console.log('\nAvailable contexts:');
    runCommand('kubectl config get-contexts', { stdio: 'inherit' });
  } catch (error) {
    console.error('\nError checking kubectl context:', error.message);
  }
}

async function main() {
  console.log('=== df-sim GitHub Variables Tool ===\n');

  let exit = false;

  while (!exit) {
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: 'Check kubectl context', value: 'check_context' },
          { name: 'Get GitHub variables', value: 'get_variables' },
          { name: 'Deploy application (Helm)', value: 'deploy' },
          { name: 'Undeploy application (Helm)', value: 'undeploy' },
          { name: 'Deploy nginx proxy (mTLS)', value: 'deploy_nginx' },
          { name: 'Remove nginx proxy', value: 'remove_nginx' },
          { name: 'Deploy custom Keycloak (X509)', value: 'deploy_keycloak' },
          { name: 'Remove custom Keycloak', value: 'remove_keycloak' },
          { name: 'Deploy ArgoCD application', value: 'deploy_argocd' },
          { name: 'Remove ArgoCD application', value: 'remove_argocd' },
          { name: 'Show cluster passwords', value: 'get_passwords' },
          { name: 'Exit', value: 'exit' }
        ]
      }
    ]);

    switch (answers.action) {
      case 'check_context':
        await checkKubectlContext();
        console.log('\n');
        break;
      case 'get_variables':
        await getGitHubVariables();
        console.log('\n');
        break;
      case 'deploy':
        await deployApp();
        console.log('\n');
        break;
      case 'undeploy':
        await undeployApp();
        console.log('\n');
        break;
      case 'deploy_nginx':
        await deployNginx();
        console.log('\n');
        break;
      case 'remove_nginx':
        await removeNginx();
        console.log('\n');
        break;
      case 'deploy_keycloak':
        await deployKeycloak();
        console.log('\n');
        break;
      case 'remove_keycloak':
        await removeKeycloak();
        console.log('\n');
        break;
      case 'deploy_argocd':
        await deployArgoCDApp();
        console.log('\n');
        break;
      case 'remove_argocd':
        await removeArgoCDApp();
        console.log('\n');
        break;
      case 'get_passwords':
        await getPasswords();
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
