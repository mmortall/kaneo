[CmdletBinding()]
param(
    [string]$AccountId = "d7e71a5978988490217722fcd2fc69c7",
    [string]$TunnelId = "8251e1bf-ac25-43d7-a24f-3dd40338eb4f",
    [string]$Hostname = "admin.polyquantlabs.xyz",
    [int]$ProxyPort = 5180
)

$ErrorActionPreference = "Stop"
$token = [Environment]::GetEnvironmentVariable("CLOUDFLARE_API_TOKEN", "Machine")
if (-not $token) { throw "CLOUDFLARE_API_TOKEN is missing in Machine environment variables." }

try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$ProxyPort/kaneo/api/health" -TimeoutSec 5
    if ($health.StatusCode -ne 200) { throw "Kaneo proxy health check returned HTTP $($health.StatusCode)." }
} catch {
    throw "Kaneo proxy is unavailable on port $ProxyPort. $($_.Exception.Message)"
}

$headers = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }
$uri = "https://api.cloudflare.com/client/v4/accounts/$AccountId/cfd_tunnel/$TunnelId/configurations"
$response = Invoke-RestMethod -Uri $uri -Headers $headers -Method Get
if (-not $response.success) { throw "Cloudflare tunnel configuration query failed." }

$paths = @("^/kaneo(?:/|$)", "^/linear(?:/|$)")
$service = "http://localhost:$ProxyPort"
$ingress = @($response.result.config.ingress | Where-Object {
    -not ($_.hostname -eq $Hostname -and $paths -contains $_.path)
})
$insertAt = [Array]::FindIndex([object[]]$ingress, [Predicate[object]]{
    param($rule)
    $rule.hostname -eq $Hostname -and [string]::IsNullOrEmpty($rule.path)
})
if ($insertAt -lt 0) { throw "Admin catch-all ingress rule was not found." }

$kaneoRules = @(
    @{ hostname = $Hostname; path = "^/kaneo(?:/|$)"; service = $service },
    @{ hostname = $Hostname; path = "^/linear(?:/|$)"; service = $service }
)
$updatedIngress = @($ingress[0..($insertAt - 1)] + $kaneoRules + $ingress[$insertAt..($ingress.Count - 1)])
$config = $response.result.config
$config.ingress = $updatedIngress
$body = @{ config = $config } | ConvertTo-Json -Depth 20
$updated = Invoke-RestMethod -Uri $uri -Headers $headers -Method Put -Body $body
if (-not $updated.success) { throw "Cloudflare tunnel configuration update failed." }

$verified = Invoke-RestMethod -Uri $uri -Headers $headers -Method Get
$installed = @($verified.result.config.ingress | Where-Object {
    $_.hostname -eq $Hostname -and $paths -contains $_.path -and $_.service -eq $service
})
if ($installed.Count -ne 2) { throw "Kaneo Cloudflare ingress verification failed." }
Write-Output "Kaneo tunnel rules are active at /kaneo and /linear."
