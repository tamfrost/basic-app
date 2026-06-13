# Pomerium + Keycloak protection for `basic-app` on CRC

**Status:** ✅ Working — `basic-app` is served at `https://basic.apps-crc.testing`, fronted by Pomerium, authenticated against Keycloak (`auth.jolundq.se`, realm `basic`), with TLS from an internal CA (`clusterissuer-primkey-acme`).

This document describes the final architecture, every component that was installed, the request flow, credentials, how to add another app, maintenance, and the dead-ends we ruled out (and why).

---

## 1. Outcome at a glance

| Thing | Value |
|---|---|
| App URL | `https://basic.apps-crc.testing` |
| App namespace | `basic` (Deployment + Service `basic-app`, port 80) |
| Reverse proxy / authZ | Pomerium Ingress Controller (namespace `pomerium`) |
| Identity provider | Keycloak `https://auth.jolundq.se`, realm **`basic`**, client `pomerium` |
| TLS | cert-manager + internal CA `clusterissuer-primkey-acme` (issuer CN `primkey-internal-ca`, valid to 2036) |
| Login users (realm `basic`) | `jolundq` / `password` · `johan` / `Basic-9df3ab64!` |
| CA to trust in browser | `~/primkey-ca.crt` on the Mac |

The cluster is **not exposed to the internet**. Hostnames live under the internal `apps-crc.testing` domain and resolve locally; certs are issued by an internal CA via DNS-less cert-manager (CA issuer needs no ACME challenge).

---

## 2. Environment

- **CRC / OpenShift** runs on the Mac — `ssh mac` (user `frostfire`, host `Tamsins-MBP`, LAN IP `192.168.1.82`).
- OpenShift version 4.21.8, apps domain `apps-crc.testing`.
- CRC forwards **`*:443`** on the Mac to the in-VM OpenShift router (so other LAN devices can reach it too); the API is on `127.0.0.1:6443`.
- `oc` binary is under `~/.crc/bin/oc/`; activate with `eval $(crc oc-env)`.
- **kubeconfig:** use the cert-based admin file — it survives restarts (unlike `oc login`, which can fail right after `crc start` before the OAuth server is ready):
  ```bash
  export KUBECONFIG=$HOME/.crc/machines/crc/kubeconfig   # system:admin
  ```

---

## 3. Architecture & request flow

```
                          (browser, resolves *.apps-crc.testing locally; trusts primkey CA)
                                              │  https://basic.apps-crc.testing
                                              ▼
                       OpenShift HAProxy router  (Mac *:443, passthrough Route)
                                              │  SNI: basic.apps-crc.testing
                                              ▼
                    Pomerium proxy  (svc pomerium-proxy, ns pomerium)
                    · terminates TLS with basic-app-tls (primkey CA)
                    · no session?  ─── 302 ──▶ authenticate.apps-crc.testing/.pomerium/sign_in
                                                       │
                                                       ▼
                                  Keycloak  auth.jolundq.se/realms/basic
                                  (client_id=pomerium, redirect_uri=
                                   https://authenticate.apps-crc.testing/oauth2/callback)
                                                       │  user logs in
                                                       ▼
                                  callback ▶ Pomerium sets session cookie
                                              │
                                              ▼
                    Pomerium proxies the now-authenticated request to
                    Service basic-app.basic.svc:80  (injecting identity headers)
```

Two OpenShift **passthrough** Routes (so Pomerium — not the OpenShift router — terminates TLS and sees the host):

- `pomerium-basic` → `basic.apps-crc.testing`
- `pomerium-authenticate` → `authenticate.apps-crc.testing`

both targeting Service `pomerium-proxy:https`.

---

## 4. What was installed, step by step

### 4.1 cert-manager (TLS engine)

Installed via Helm into namespace `cert-manager`:

```bash
helm repo add jetstack https://charts.jetstack.io && helm repo update
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  --version v1.20.2 --set crds.enabled=true --wait
```

### 4.2 Internal CA issuer — `clusterissuer-primkey-acme`

Your `app-pomerium` chart annotates each Ingress with `cert-manager.io/cluster-issuer: clusterissuer-primkey-acme`. That issuer didn't exist on this cluster, so it was recreated as a **self-signed root CA** (a CA issuer signs instantly — no ACME challenge, no internet needed, perfect for `.testing` hostnames):

```yaml
# 1) bootstrap self-signed issuer
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: selfsigned }
spec: { selfSigned: {} }
---
# 2) the root CA certificate (10-year)
apiVersion: cert-manager.io/v1
kind: Certificate
metadata: { name: primkey-ca, namespace: cert-manager }
spec:
  isCA: true
  commonName: primkey-internal-ca
  secretName: primkey-ca-secret
  duration: 87600h
  privateKey: { algorithm: ECDSA, size: 256 }
  issuerRef: { name: selfsigned, kind: ClusterIssuer, group: cert-manager.io }
---
# 3) the CA ClusterIssuer that apps reference
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: clusterissuer-primkey-acme }
spec:
  ca: { secretName: primkey-ca-secret }
```

CA cert exported for browser trust:
```bash
oc get secret primkey-ca-secret -n cert-manager -o jsonpath='{.data.ca\.crt}' | base64 -d > ~/primkey-ca.crt
```

### 4.3 Pomerium Ingress Controller

Installed cluster-wide (gives `ingressclass pomerium`, namespace `pomerium`, the `Pomerium` CRD, and the `pomerium-proxy` Service):

```bash
oc apply -k 'github.com/pomerium/ingress-controller/config/default?ref=v0.32.8'
```

**OpenShift fix (required):** the upstream pods are rejected by OpenShift SCC (controller runs as uid 65532, gen-secrets as uid/fsGroup 1000). Grant `nonroot-v2`:

```bash
oc adm policy add-scc-to-user nonroot-v2 -z pomerium-controller   -n pomerium
oc adm policy add-scc-to-user nonroot-v2 -z pomerium-gen-secrets  -n pomerium
oc rollout restart deploy/pomerium -n pomerium
```

### 4.4 Pomerium secrets

**Bootstrap secret** `pomerium/bootstrap` — `shared_secret`/`cookie_secret` must decode to **raw 32 bytes** (a base64-of-32-bytes value placed directly in `data:`; using `--from-literal` of a base64 string gives 44 bytes and Pomerium errors *"shared_secret should be 32 bytes, got 44"*):

```bash
cat <<YAML | oc apply -f -
apiVersion: v1
kind: Secret
metadata: { name: bootstrap, namespace: pomerium }
type: Opaque
data:
  shared_secret: $(openssl rand -base64 32)
  cookie_secret: $(openssl rand -base64 32)
  signing_key:   $(openssl ecparam -genkey -name prime256v1 -noout | base64 | tr -d '\n')
YAML
```

**IdP secret** `pomerium/idp` — the Keycloak client credentials:

```bash
oc create secret generic idp -n pomerium \
  --from-literal=client_id=pomerium \
  --from-literal=client_secret=GLjWlxx9B33BDVycReQFB9ul3MR9p2CJ
```

### 4.5 authenticate hostname cert

Pomerium needs a dedicated authenticate URL with its own cert:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata: { name: authenticate-tls, namespace: pomerium }
spec:
  secretName: authenticate-tls
  dnsNames: [ authenticate.apps-crc.testing ]
  issuerRef: { name: clusterissuer-primkey-acme, kind: ClusterIssuer, group: cert-manager.io }
```

### 4.6 Global `Pomerium` config CR

```yaml
apiVersion: ingress.pomerium.io/v1
kind: Pomerium
metadata: { name: global }
spec:
  secrets: pomerium/bootstrap
  authenticate:
    url: https://authenticate.apps-crc.testing
  identityProvider:
    provider: oidc
    url: https://auth.jolundq.se/realms/basic
    secret: pomerium/idp
    scopes: [ openid, email, profile ]
  certificates:
    - pomerium/authenticate-tls
```

### 4.7 OpenShift passthrough Routes (LAN exposure)

```yaml
apiVersion: route.openshift.io/v1
kind: Route
metadata: { name: pomerium-basic, namespace: pomerium }
spec:
  host: basic.apps-crc.testing
  to: { kind: Service, name: pomerium-proxy }
  port: { targetPort: https }
  tls: { termination: passthrough, insecureEdgeTerminationPolicy: Redirect }
---
apiVersion: route.openshift.io/v1
kind: Route
metadata: { name: pomerium-authenticate, namespace: pomerium }
spec:
  host: authenticate.apps-crc.testing
  to: { kind: Service, name: pomerium-proxy }
  port: { targetPort: https }
  tls: { termination: passthrough, insecureEdgeTerminationPolicy: Redirect }
```

> The `basic.apps-crc.testing` host was initially `HostAlreadyClaimed` by a stale Route/Service in a `dspdf` project (no Deployment behind it). That project was deleted to free the host.

### 4.8 Keycloak realm, client, users

On `auth.jolundq.se` (admin user `johan`, realm `master`), via the Admin REST API:

- Created realm **`basic`**.
- Created confidential client **`pomerium`**: `standardFlowEnabled`, redirect URI `https://authenticate.apps-crc.testing/oauth2/callback`, `webOrigins: ["+"]`. Client secret → stored in `pomerium/idp`.
- Created users `johan` and `jolundq` (passwords above, `temporary=false`).
- Disabled the **`VERIFY_PROFILE`** required action in realm `basic` so login isn't interrupted by the "Update Account Information" dialog.

### 4.9 The app (`basic` namespace)

Deployed via your `app-pomerium` Helm chart. The resulting Ingress:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: basic-app
  namespace: basic
  annotations:
    cert-manager.io/cluster-issuer: clusterissuer-primkey-acme
    ingress.pomerium.io/allow_any_authenticated_user: "true"
    ingress.pomerium.io/pass_identity_headers: "true"
spec:
  ingressClassName: pomerium
  tls:
    - hosts: [ basic.apps-crc.testing ]
      secretName: basic-app-tls
  rules:
    - host: basic.apps-crc.testing
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: basic-app, port: { number: 80 } } }
```

cert-manager sees the annotation + `tls` block and auto-issues `basic-app-tls` from the primkey CA. Pomerium serves that cert and proxies authenticated traffic to `basic-app:80`.

> During setup the Ingress was first created with `acmeIssuerName: -` (the issuer didn't exist yet, so the chart omitted the cert annotation/TLS). It was patched in once `clusterissuer-primkey-acme` existed. Re-running the `app-pomerium` deploy now finds the issuer and wires this automatically.

---

## 5. How to add another app (the reusable pattern)

Pomerium is now a **general cluster tool**. Any new app just needs an Ingress in its own namespace:

1. Deploy the app (Deployment + Service).
2. Create an Ingress with:
   - `ingressClassName: pomerium`
   - `cert-manager.io/cluster-issuer: clusterissuer-primkey-acme`
   - `ingress.pomerium.io/allow_any_authenticated_user: "true"` (or a finer policy)
   - host under `*.apps-crc.testing`, `tls.secretName: <app>-tls`
3. Add an OpenShift **passthrough** Route for that host → `pomerium-proxy:https` (only needed because OpenShift's router sits in front of Pomerium on CRC).

That's exactly what the `app-pomerium` chart does. No changes to Pomerium core.

---

## 6. Maintenance

- **Cert renewal:** automatic. cert-manager renews the leaf certs (`basic-app-tls`, `authenticate-tls`) from the primkey CA; the CA itself is valid until **2036**. No cron/ACME job needed.
- **Trusting the CA:** import `~/primkey-ca.crt` into the Mac Keychain (and any other client device) to remove browser warnings. Other LAN devices also need `*.apps-crc.testing` to resolve to the CRC router IP.
- **After `crc start`:** if `oc` says "Missing or incomplete configuration", re-export `KUBECONFIG=$HOME/.crc/machines/crc/kubeconfig`.

---

## 7. Dead-ends we ruled out (context)

The original ask was a public `basic.jolundq.se` Let's Encrypt cert without internet exposure. Along the way:

1. **acme-dns on Hostinger** — abandoned. **Loopia does not honor in-zone NS subdomain delegation**, so the `_acme-challenge` CNAME → acme-dns target dead-ends at Loopia (NXDOMAIN). acme-dns can't work while DNS is on Loopia.
2. **cert-manager-webhook-loopia** — abandoned. The only published image (Identitry/ExhaleSthlm) is **amd64-only and from 2021**; it crashes with a Go runtime panic on CRC's **arm64** (Apple Silicon) node.
3. **lego `--dns loopia`** — *worked* and issued a real Let's Encrypt cert for `basic.jolundq.se` via DNS-01. This is now **unused**, because you chose to replicate your established internal pattern (`apps-crc.testing` + `clusterissuer-primkey-acme` + Pomerium controller + Keycloak) instead of the public-LE path.

### Leftovers from path #3 (safe to delete)
- Secret `basic-tls` in namespace `basic` (LE cert for `basic.jolundq.se`; the app uses `basic-app-tls` instead).
- On the Mac: `~/lego-prod`, `~/lego-data`, `~/bin/lego`.
- No Loopia DNS records were created (that step was declined), so nothing to undo at Loopia.

---

## 8. Quick verification

```bash
ssh mac 'eval $(crc oc-env); export KUBECONFIG=$HOME/.crc/machines/crc/kubeconfig
  oc get pods -n pomerium
  oc get pomerium global
  oc get certificate -A | grep -E "basic-app|authenticate"
  oc get route -n pomerium
  # full chain (expect 302 -> authenticate -> Keycloak 200):
  curl -k -sIL https://basic.apps-crc.testing | grep -iE "HTTP|location" | head'
```
