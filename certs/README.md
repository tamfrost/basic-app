# Corporate CA Certificates

Place your corporate CA certificates (`.crt` or `.pem` files) in this directory.

## How to get your corporate CA certificate:

### Option 1: Export from your browser

**Firefox:**
1. Settings → Privacy & Security → Security → View Certificates
2. Go to "Authorities" tab
3. Find your corporate CA certificate
4. Select and click "Export"
5. Save as PEM format with `.crt` extension

**Chrome:**
1. Settings → Privacy and security → Security → Manage certificates
2. Go to "Authorities" tab
3. Find your corporate CA certificate
4. Export as PEM format

### Option 2: Extract from system (Linux)

```bash
# Check if your corporate cert is already installed
ls /etc/ssl/certs/ | grep -i <your-company-name>

# Copy it to this directory
cp /etc/ssl/certs/your-corporate-ca.crt ./certs/
```

### Option 3: Get from IT department

Contact your IT department and request the corporate root CA certificate in PEM/CRT format.

## File format

Certificates should be in PEM format with `.crt` extension. Example:

```
-----BEGIN CERTIFICATE-----
MIIDXTCCAkWgAwIBAgIJAKL0UG+mRKuWMA0GCSqGSIb3DQEBCwUAMEUxCzAJBgNV
...
-----END CERTIFICATE-----
```

## Security Note

Do not commit actual certificate files to git. This directory is for local use only.
Add `certs/*.crt` to `.gitignore` if you want to keep certificates out of version control.

One thing to verify: the solvers section in clusterissuer.yaml uses http01 with ingressClass: nginx. Depending on how your internal CA validates ownership (and whether your cluster uses a different ingress class), you may need to adjust that. If your CA skips challenge validation entirely for internal networks, the solvers block can be left empty (solvers: []).

Also, cert-manager must be installed in the cluster — if it isn't yet, helm install cert-manager jetstack/cert-manager --set installCRDs=true in the cert-manager namespace is the standard one-liner.