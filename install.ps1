#Requires -Version 5.1
<#
  Claude Code timetec-bugs-mcp installer (one-shot).

  Sets up the timetec-bugs MCP server in Claude Code:
    1. Runs `npm install` in this folder (Node dependencies)
    2. Prompts for environment, credentials, and optional paths
    3. Registers the MCP server in either:
         - User scope:    ~/.claude.json   (default)
         - Project scope: ./.mcp.json      (-Scope Project)

  Safe to re-run: existing values are shown as defaults; press Enter
  to keep them. The password prompt also accepts Enter to keep the
  previously configured password.

  Usage:
    .\install.ps1                                  # user scope, name "timetec-bugs"
    .\install.ps1 -Scope Project                   # write to .\.mcp.json
    .\install.ps1 -Name timetec-bugs-sit           # custom entry name
    .\install.ps1 -SkipCredentials                 # register entry without
                                                   # prompting for email/password;
                                                   # user supplies them later via
                                                   # the `setup_credentials` MCP tool
#>
[CmdletBinding()]
param(
    [string]$TargetRoot = $env:USERPROFILE,
    [ValidateSet('User','Project')]
    [string]$Scope = 'User',
    [string]$Name  = 'timetec-bugs',

    # ---- Non-interactive overrides (Claude-driven installs) ----
    # Pass any/all of these to skip the matching Read-Host prompt. Anything
    # left empty falls back to the interactive flow, so partial overrides
    # are fine.
    [ValidateSet('','Live','SIT','Custom')]
    [string]$Environment = '',
    [string]$BaseUrl = '',                # only used when -Environment Custom
    [string]$Email = '',
    [string]$Password = '',
    [string]$AdbPath = '',
    [string]$OneDriveSyncFolder = '',
    [string]$SharepointBaseUrl = '',

    # Skip the credential prompts + login-verification entirely. The MCP entry
    # is registered without TIMETEC_EMAIL / TIMETEC_PASSWORD in the env block;
    # the server's `setup_credentials` tool can be called later from inside
    # Claude Code to fill them in (persists to ~/.timetec-bugs-mcp/config.json).
    [switch]$SkipCredentials
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$m) { Write-Host "  $m" -ForegroundColor Cyan }
function Write-Ok  ([string]$m) { Write-Host "  $m" -ForegroundColor Green }
function Write-Warn([string]$m) { Write-Host "  $m" -ForegroundColor Yellow }
function Write-Err ([string]$m) { Write-Host "  $m" -ForegroundColor Red }

function Read-PromptDefault {
    param([string]$Label, [string]$Default)
    if ([string]::IsNullOrWhiteSpace($Default)) {
        return (Read-Host "  $Label")
    }
    $v = Read-Host "  $Label [$Default]"
    if ([string]::IsNullOrWhiteSpace($v)) { return $Default }
    return $v
}

function Test-TimetecCredentials {
    <#
    Mirrors the Laravel-style CSRF login flow in server.js (login()):
      1. GET /login  → harvest csrf-token meta + XSRF-TOKEN cookie
      2. POST /login with {email, password} + X-CSRF-TOKEN + X-Requested-With
    Returns $true on HTTP < 400, $false otherwise. Network errors return $false.
    #>
    param([string]$BaseUrl, [string]$Email, [string]$Password)
    Add-Type -AssemblyName System.Web -ErrorAction SilentlyContinue
    try {
        $session = $null
        $loginPage = Invoke-WebRequest -Uri "$BaseUrl/login" `
            -SessionVariable session -UseBasicParsing `
            -Headers @{ Accept = 'text/html' } -ErrorAction Stop
        $csrfToken = ''
        if ($loginPage.Content -match 'name="csrf-token"\s+content="([^"]+)"') {
            $csrfToken = $matches[1]
        }
        $xsrf = $session.Cookies.GetCookies($BaseUrl) | Where-Object { $_.Name -eq 'XSRF-TOKEN' }
        if ($xsrf -and -not $csrfToken) {
            $csrfToken = [System.Web.HttpUtility]::UrlDecode($xsrf.Value)
        }
        $body = @{ email = $Email; password = $Password } | ConvertTo-Json -Compress
        Invoke-WebRequest -Uri "$BaseUrl/login" -WebSession $session -Method POST `
            -Body $body -ContentType 'application/json' `
            -Headers @{
                'X-CSRF-TOKEN'     = $csrfToken
                'X-Requested-With' = 'XMLHttpRequest'
                'Accept'           = 'application/json'
            } -UseBasicParsing -ErrorAction Stop | Out-Null
        return $true
    } catch {
        $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        Write-Warn "Login attempt rejected (HTTP $code): $($_.Exception.Message)"
        return $false
    }
}

function Read-PasswordWithDefault {
    param([string]$Label, [string]$ExistingValue)
    $hint = if ($ExistingValue) { ' (Enter to keep existing)' } else { '' }
    $secure = Read-Host -AsSecureString "  ${Label}${hint}"
    if ($secure.Length -eq 0) { return $ExistingValue }
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

Write-Host ""
Write-Host "  === timetec-bugs-mcp installer ===" -ForegroundColor White
Write-Host ""

# --- paths --------------------------------------------------------
$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverJs    = Join-Path $scriptDir "server.js"
$entryPoint  = Join-Path $scriptDir "bootstrap.js"
$packageJson = Join-Path $scriptDir "package.json"

if ($Scope -eq 'User') {
    $configPath = Join-Path $TargetRoot ".claude.json"
} else {
    $configPath = Join-Path (Get-Location).Path ".mcp.json"
}

# --- prerequisite checks ------------------------------------------
Write-Step "Checking source files..."
if (-not (Test-Path $serverJs))    { Write-Err "Missing server.js - run from timetec-bugs-mcp folder root."; exit 1 }
if (-not (Test-Path $entryPoint))  { Write-Err "Missing bootstrap.js - run from timetec-bugs-mcp folder root."; exit 1 }
if (-not (Test-Path $packageJson)) { Write-Err "Missing package.json"; exit 1 }
Write-Ok "Source files OK"

Write-Step "Checking Node..."
$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
    Write-Err "Node not found on PATH. Install from https://nodejs.org/ first."
    exit 1
}
Write-Ok "Node OK: $($node.Source)"

# --- 1. npm install ----------------------------------------------
Write-Step "Running npm install in $scriptDir ..."
Push-Location $scriptDir
try {
    $npmOutput = & npm install --silent 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Err "npm install failed:"
        Write-Host $npmOutput
        exit 1
    }
} finally {
    Pop-Location
}
Write-Ok "Dependencies installed."

# --- 2. read existing config -------------------------------------
$config = $null
if (Test-Path $configPath) {
    try {
        $raw = Get-Content $configPath -Raw -Encoding UTF8
        if ($raw.Trim()) { $config = $raw | ConvertFrom-Json }
    } catch {
        Write-Warn "Existing $configPath failed to parse; backing up to $configPath.bak"
        Copy-Item $configPath "$configPath.bak" -Force
        $config = $null
    }
}
if ($null -eq $config) { $config = [PSCustomObject]@{} }
if (-not ($config.PSObject.Properties.Name -contains 'mcpServers')) {
    $config | Add-Member -MemberType NoteProperty -Name 'mcpServers' -Value ([PSCustomObject]@{})
}

$existing = $null
if ($config.mcpServers.PSObject.Properties.Name -contains $Name) {
    $existing = $config.mcpServers.$Name
}
$existingEnv = if ($existing -and $existing.env) { $existing.env } else { [PSCustomObject]@{} }

function Get-ExistingEnv([string]$k) {
    if ($existingEnv.PSObject.Properties.Name -contains $k) { return [string]$existingEnv.$k }
    return ''
}

# --- 3. prompts ---------------------------------------------------
Write-Host ""
Write-Step "Configure timetec-bugs MCP entry"
Write-Host "    Entry name : $Name"
Write-Host "    Scope      : $Scope"
Write-Host "    Config file: $configPath"
Write-Host ""

$liveUrl = 'https://dt.timeteccloud.com'
$sitUrl  = 'https://dt-dev.timeteccloud.com'
$existingUrl = Get-ExistingEnv 'TIMETEC_BASE_URL'

$presetDefault = '1'
if ($existingUrl -eq $sitUrl)                                    { $presetDefault = '2' }
elseif ($existingUrl -and $existingUrl -ne $liveUrl)             { $presetDefault = '3' }

# Environment selection — non-interactive when -Environment is supplied.
switch ($Environment) {
    'Live'   { $baseUrl = $liveUrl;                                 Write-Ok "Using -Environment Live"   }
    'SIT'    { $baseUrl = $sitUrl;                                  Write-Ok "Using -Environment SIT"    }
    'Custom' {
        if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
            Write-Err "-Environment Custom requires -BaseUrl <url>."
            exit 1
        }
        $baseUrl = $BaseUrl
        Write-Ok "Using -Environment Custom: $baseUrl"
    }
    default {
        # No -Environment override → fall back to interactive picker.
        Write-Host "  Environment:"
        Write-Host "    1) Live  ($liveUrl)"
        Write-Host "    2) SIT   ($sitUrl)"
        Write-Host "    3) Custom URL"
        $preset = Read-PromptDefault "Choose [1/2/3]" $presetDefault

        switch ($preset) {
            '2' { $baseUrl = $sitUrl }
            '3' { $baseUrl = Read-PromptDefault "Custom base URL" $existingUrl }
            default { $baseUrl = $liveUrl }
        }
    }
}

if ($SkipCredentials) {
    Write-Step "Skipping credential prompts (-SkipCredentials)."
    Write-Host '    Use the MCP''s setup_credentials tool from Claude Code to configure them later.' -ForegroundColor DarkGray
    $email = ''
    $password = ''
} else {
    # Email / password — honour -Email / -Password when supplied.
    if ($Email) {
        $email = $Email
        Write-Ok "Using -Email parameter."
    } else {
        $email = Read-PromptDefault "Email" (Get-ExistingEnv 'TIMETEC_EMAIL')
    }
    if ($Password) {
        $password = $Password
        Write-Ok "Using -Password parameter (skipping hidden prompt)."
    } else {
        $password = Read-PasswordWithDefault "Password" (Get-ExistingEnv 'TIMETEC_PASSWORD')
    }

    if ([string]::IsNullOrWhiteSpace($email))    { Write-Err "Email is required."; exit 1 }
    if ([string]::IsNullOrWhiteSpace($password)) { Write-Err "Password is required."; exit 1 }

    # --- 3b. verify credentials work against the TimeTec base URL --------
    # No domain check — the auth attempt IS the gate. In interactive mode we
    # loop on failure so the user can retype without re-running the script.
    # In non-interactive mode (-Email AND -Password supplied) we exit 1 on
    # first failure so the calling agent can re-collect creds and re-invoke.
    $nonInteractiveCreds = $Email -and $Password
    Write-Step "Verifying credentials against $baseUrl ..."
    while ($true) {
        if (Test-TimetecCredentials -BaseUrl $baseUrl -Email $email -Password $password) {
            Write-Ok "Login OK ($email)."
            break
        }
        if ($nonInteractiveCreds) {
            Write-Err "Login failed for $email — credentials rejected by $baseUrl."
            Write-Err "Re-run with corrected -Email / -Password, or omit them to enter interactively."
            exit 1
        }
        Write-Warn "Login failed — please re-enter your credentials."
        $email    = Read-PromptDefault       "Email"    $email
        $password = Read-PasswordWithDefault "Password" $password
        if ([string]::IsNullOrWhiteSpace($email))    { Write-Err "Email is required."; exit 1 }
        if ([string]::IsNullOrWhiteSpace($password)) { Write-Err "Password is required."; exit 1 }
    }
}

# Optional paths — honour overrides; otherwise prompt with the previous value as default.
$adbDefault = Get-ExistingEnv 'ADB_PATH'
if (-not $adbDefault) {
    $adbDefault = Join-Path $env:USERPROFILE "AppData\Local\Android\Sdk\platform-tools\adb.exe"
}
if ($PSBoundParameters.ContainsKey('AdbPath')) {
    $adbPath = $AdbPath
} else {
    $adbPath = Read-PromptDefault "ADB path (optional)" $adbDefault
}
if ($PSBoundParameters.ContainsKey('OneDriveSyncFolder')) {
    $onedrive = $OneDriveSyncFolder
} else {
    $onedrive = Read-PromptDefault "OneDrive sync folder (optional)" (Get-ExistingEnv 'ONEDRIVE_SYNC_FOLDER')
}
if ($PSBoundParameters.ContainsKey('SharepointBaseUrl')) {
    $sharepoint = $SharepointBaseUrl
} else {
    $sharepoint = Read-PromptDefault "SharePoint base URL (optional)" (Get-ExistingEnv 'SHAREPOINT_BASE_URL')
}

# --- 4. build entry (preserve any existing env keys we didn't ask) ---
$envObj = [PSCustomObject]@{}
foreach ($p in $existingEnv.PSObject.Properties) {
    $envObj | Add-Member -MemberType NoteProperty -Name $p.Name -Value $p.Value -Force
}
$envObj | Add-Member -MemberType NoteProperty -Name 'TIMETEC_BASE_URL' -Value $baseUrl  -Force
if ($email)      { $envObj | Add-Member -MemberType NoteProperty -Name 'TIMETEC_EMAIL'        -Value $email      -Force }
if ($password)   { $envObj | Add-Member -MemberType NoteProperty -Name 'TIMETEC_PASSWORD'     -Value $password   -Force }
if ($adbPath)    { $envObj | Add-Member -MemberType NoteProperty -Name 'ADB_PATH'             -Value $adbPath    -Force }
if ($onedrive)   { $envObj | Add-Member -MemberType NoteProperty -Name 'ONEDRIVE_SYNC_FOLDER' -Value $onedrive   -Force }
if ($sharepoint) { $envObj | Add-Member -MemberType NoteProperty -Name 'SHAREPOINT_BASE_URL'  -Value $sharepoint -Force }

$desiredEntry = [PSCustomObject]@{
    command = 'node'
    args    = @($entryPoint)
    env     = $envObj
}

# --- 5. write -----------------------------------------------------
$action = if ($existing) { 'updated' } else { 'added' }
if ($existing) {
    $config.mcpServers.$Name = $desiredEntry
} else {
    $config.mcpServers | Add-Member -MemberType NoteProperty -Name $Name -Value $desiredEntry
}

$configDir = Split-Path -Parent $configPath
if ($configDir -and -not (Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
}
($config | ConvertTo-Json -Depth 20) | Set-Content -Path $configPath -Encoding UTF8
Write-Ok "MCP entry $action."

# --- summary -----------------------------------------------------
Write-Host ""
Write-Host "  === Done ===" -ForegroundColor Green
Write-Host ""
Write-Host "  Entry name : $Name"
Write-Host "  MCP server : $entryPoint"
Write-Host "  Base URL   : $baseUrl"
if ($email) {
    Write-Host "  Email      : $email"
} else {
    Write-Host "  Email      : (not set — call the MCP's setup_credentials tool from Claude Code)" -ForegroundColor Yellow
}
Write-Host "  Config file: $configPath"
Write-Host ""
Write-Host "  Restart Claude Code to pick it up."
Write-Host ""
