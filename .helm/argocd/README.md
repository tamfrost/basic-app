# ArgoCD Deployment for df-sim

This directory contains ArgoCD manifests for deploying df-sim using the Helm chart from the infra repository.

## Prerequisites

- OpenShift GitOps operator installed in your cluster
- Access to the openshift-gitops namespace

## Files

- `repo-secret.yaml` - Repository authentication using GitHub App credentials
- `application.yaml` - ArgoCD Application manifest

## Deployment Steps

### 1. Apply the Repository Secret

First, apply the repository secret to allow ArgoCD to access the private infra repository:

```bash
kubectl apply -f .helm/argocd/repo-secret.yaml
```

This secret contains:
- GitHub App ID: 3507219
- GitHub App Installation ID: 127170308
- GitHub App Private Key (from .env file)

### 2. Deploy the Application

Apply the ArgoCD Application manifest:

```bash
kubectl apply -f .helm/argocd/application.yaml
```

This will:
- Configure ArgoCD to sync from `https://github.com/tamfrost/infra`
- Use the Helm chart at path `helmcharts/df-sim`
- Deploy to the `df-sim` namespace (auto-created)
- Enable automatic sync with self-healing

### 3. Verify Deployment

Check the application status in ArgoCD:

```bash
# Using ArgoCD CLI
argocd app get df-sim

# Using kubectl
kubectl get application df-sim -n openshift-gitops
```

Access the ArgoCD UI to view the deployment status and resources.

## Configuration

The application is configured with:

- **Source Repository**: https://github.com/tamfrost/infra
- **Helm Chart Path**: helmcharts/df-sim
- **Target Namespace**: df-sim
- **Image Registry**: ghcr.io
- **Image Repository**: tamfrost/df-sim

### Auto-Sync Settings

The application has automatic sync enabled with:
- **Prune**: Remove resources when removed from Git
- **Self-Heal**: Automatically fix drift from desired state
- **Retry**: Up to 5 retries with exponential backoff

## Updating the Deployment

To update the deployment:

1. Modify the Helm chart in the infra repository
2. Commit and push changes
3. ArgoCD will automatically detect and sync the changes

Or manually sync:

```bash
argocd app sync df-sim
```

## Removing the Deployment

To remove the application:

```bash
kubectl delete -f .helm/argocd/application.yaml
```

To also remove the repository secret:

```bash
kubectl delete -f .helm/argocd/repo-secret.yaml
```
