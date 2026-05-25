param(
    [string]$AppName  = "basic-app",
    [string]$Namespace = "dspdf",
    [string]$Issuer   = "clusterissuer-primkey-acme"
)

$secretName = "$AppName-nginx-tls"

function Section($title) {
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "  $title" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
}

function Run($cmd) {
    Write-Host "> $cmd" -ForegroundColor DarkGray
    Invoke-Expression $cmd
}

# ── 1. Ingress ──────────────────────────────────────────────────────────────
Section "Ingress"
Run "kubectl get ingress $AppName -n $Namespace -o yaml"

# ── 2. ClusterIssuer ────────────────────────────────────────────────────────
Section "ClusterIssuer: $Issuer"
Run "kubectl get clusterissuer $Issuer -o yaml"

# ── 3. Certificate CRs ──────────────────────────────────────────────────────
Section "Certificate resources in namespace $Namespace"
Run "kubectl get certificate,certificaterequest,order,challenge -n $Namespace"

# ── 4. Describe Certificate (if it exists) ──────────────────────────────────
Section "Describe Certificate: $secretName"
Run "kubectl describe certificate $secretName -n $Namespace"

# ── 5. Describe CertificateRequest (most recent) ────────────────────────────
$crName = kubectl get certificaterequest -n $Namespace -o jsonpath="{.items[-1].metadata.name}" 2>$null
if ($crName) {
    Section "Describe CertificateRequest: $crName"
    Run "kubectl describe certificaterequest $crName -n $Namespace"
}

# ── 6. Challenges ────────────────────────────────────────────────────────────
$challenges = kubectl get challenge -n $Namespace 2>$null
if ($challenges) {
    Section "Challenges"
    Write-Host $challenges
    $challengeName = kubectl get challenge -n $Namespace -o jsonpath="{.items[0].metadata.name}" 2>$null
    if ($challengeName) {
        Run "kubectl describe challenge $challengeName -n $Namespace"
    }
}

# ── 7. TLS Secret ────────────────────────────────────────────────────────────
Section "Secret: $secretName"
Run "kubectl get secret $secretName -n $Namespace"
$b64 = kubectl get secret $secretName -n $Namespace -o "jsonpath={.data['tls\.crt']}" 2>$null
if ($b64) {
    $pem = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))
    # Write PEM to temp file and inspect with openssl
    $tmp = [System.IO.Path]::GetTempFileName() + ".pem"
    $pem | Set-Content $tmp -Encoding UTF8
    Write-Host "`nCertificate chain in secret:" -ForegroundColor Yellow
    & openssl crl2pkcs7 -nocrl -certfile $tmp | openssl pkcs7 -print_certs -noout 2>$null
    if ($LASTEXITCODE -ne 0) {
        & openssl x509 -in $tmp -noout -subject -issuer -dates 2>$null
    }
    # Count certs in chain
    $certCount = ([regex]::Matches($pem, "-----BEGIN CERTIFICATE-----")).Count
    Write-Host "Certs in chain: $certCount" -ForegroundColor Yellow
    if ($certCount -lt 2) {
        Write-Host "  -> Only leaf cert present, no CA chain!" -ForegroundColor Red
    }
    Remove-Item $tmp -ErrorAction SilentlyContinue
} else {
    Write-Host "Secret not found or tls.crt is empty" -ForegroundColor Red
}

# ── 8. cert-manager logs (last 50 lines) ────────────────────────────────────
Section "cert-manager logs (last 50 lines)"
$cmNs = kubectl get ns -o jsonpath="{.items[*].metadata.name}" 2>$null |
        ForEach-Object { $_ -split " " } |
        Where-Object { $_ -match "cert-manager" } |
        Select-Object -First 1
if ($cmNs) {
    Write-Host "cert-manager namespace: $cmNs" -ForegroundColor Yellow
    Run "kubectl logs -n $cmNs deployment/cert-manager --tail=50"
} else {
    Write-Host "cert-manager namespace not found" -ForegroundColor Red
}

# ── 9. Nginx pod cert (what nginx is actually serving) ──────────────────────
Section "Cert nginx is currently serving (live TLS handshake)"
$nginxSvc = "$AppName-nginx"
$podName = kubectl get pod -n $Namespace -l "app=$nginxSvc" -o jsonpath="{.items[0].metadata.name}" 2>$null
if (-not $podName) {
    $podName = kubectl get pod -n $Namespace -l "app.kubernetes.io/name=$AppName" -o jsonpath="{.items[0].metadata.name}" 2>$null
}
if ($podName) {
    Write-Host "Pod: $podName" -ForegroundColor Yellow
    $certInfo = kubectl exec $podName -n $Namespace -- sh -c "echo | openssl s_client -connect localhost:8443 -showcerts 2>/dev/null | openssl x509 -noout -subject -issuer -dates 2>/dev/null"
    Write-Host $certInfo
} else {
    Write-Host "No nginx pod found with label app=$nginxSvc" -ForegroundColor Red
    Run "kubectl get pods -n $Namespace"
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Done" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan
