# Store a management-scoped API key for a hosted OmniRoute instance in .env.operator
# (gitignored; not loaded by the server). The key is read without echo and never printed,
# so it never has to pass through a chat or a terminal scrollback.
#
#   pwsh scripts/ops/set-operator-key.ps1                         # keep the saved URL, replace the key
#   pwsh scripts/ops/set-operator-key.ps1 -Url https://host.example
param([string]$Url)

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$envFile = Join-Path $root ".env.operator"

$lines = @()
if (Test-Path $envFile) {
    $lines = @(Get-Content $envFile | Where-Object {
        $_ -notmatch '^OMNIROUTE_OPERATOR_KEY=' -and (-not $Url -or $_ -notmatch '^OMNIROUTE_OPERATOR_URL=')
    })
}

if ($Url) {
    $lines += "OMNIROUTE_OPERATOR_URL=$($Url.Trim().TrimEnd('/'))"
} elseif (-not ($lines | Where-Object { $_ -match '^OMNIROUTE_OPERATOR_URL=' })) {
    $entered = Read-Host "Instance URL (for example https://your-domain.example)"
    $lines += "OMNIROUTE_OPERATOR_URL=$($entered.Trim().TrimEnd('/'))"
}

$secure = Read-Host -AsSecureString "Paste the management API key, then press Enter"
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim()
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
if ([string]::IsNullOrWhiteSpace($key)) {
    Write-Host "Nothing pasted; .env.operator left unchanged." -ForegroundColor Yellow
    exit 1
}

$lines += "OMNIROUTE_OPERATOR_KEY=$key"
Set-Content -Path $envFile -Value $lines -Encoding ascii
Write-Host ("Saved a {0}-character key to {1}" -f $key.Length, $envFile) -ForegroundColor Green
