[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
Set-Location -LiteralPath $repoRoot

function Require-Tool([string]$Name, [string]$InstallUrl) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name is required. Install it from $InstallUrl and run Repair-PrintDrive.cmd again."
    }
    Write-Host "[OK] $Name" -ForegroundColor Green
}

function Invoke-Git([string[]]$Arguments) {
    & git @Arguments
    if ($LASTEXITCODE -ne 0) { throw "git $($Arguments[0]) failed." }
}

function Select-SourceFolder([string]$InitialPath) {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Select the Print Drive plaintext source folder'
    $dialog.ShowNewFolderButton = $false
    if (Test-Path -LiteralPath $InitialPath -PathType Container) { $dialog.SelectedPath = $InitialPath }
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        return [System.IO.Path]::GetFullPath($dialog.SelectedPath)
    }
    return $null
}

Write-Host 'Print Drive source recovery' -ForegroundColor Cyan
Write-Host "Repository: $repoRoot"
Require-Tool 'git' 'https://git-scm.com/download/win'
Require-Tool 'node' 'https://nodejs.org/en/download'
Require-Tool 'npm' 'https://nodejs.org/en/download'
Require-Tool 'python' 'https://www.python.org/downloads/windows/'

$configPath = Join-Path $repoRoot 'print-drive.config.json'
$sourceValue = 'private_files'
$allowedBranch = 'main'
$remote = 'origin'
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $sourceValue = [string]$config.sourceDirectory
    $allowedBranch = [string]$config.allowedBranch
    $remote = [string]$config.remote
}
$currentSource = if ([System.IO.Path]::IsPathRooted($sourceValue)) { $sourceValue } else { Join-Path $repoRoot $sourceValue }
Write-Host "Configured source: $currentSource"

$branch = (& git symbolic-ref --quiet --short HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $branch -ne $allowedBranch) {
    throw "Repair must run on configured branch '$allowedBranch'; current branch is '$branch'."
}
$dirty = (& git status --porcelain=v1) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the worktree.' }
if ($dirty) { throw 'The worktree is dirty. Commit or restore local changes before recovery.' }

Write-Host "Fetching $remote/$allowedBranch..."
Invoke-Git @('fetch', '--no-tags', $remote, "refs/heads/${allowedBranch}:refs/remotes/${remote}/${allowedBranch}")
$counts = ((& git rev-list --left-right --count "HEAD...${remote}/${allowedBranch}") -split '\s+') | Where-Object { $_ }
if ($LASTEXITCODE -ne 0 -or $counts.Count -ne 2) { throw 'Could not compare local and remote history.' }
$ahead = [int]$counts[0]
$behind = [int]$counts[1]
if ($ahead -gt 0 -and $behind -gt 0) { throw 'Local and remote histories diverged. No merge or rebase was attempted.' }
if ($ahead -gt 0) { throw 'Local branch is ahead. Review or push local commits before recovery.' }
if ($behind -gt 0) {
    Write-Host "Fast-forwarding $behind commit(s)..."
    Invoke-Git @('merge', '--ff-only', "${remote}/${allowedBranch}")
}

$selectedSource = Select-SourceFolder $currentSource
if (-not $selectedSource) { Write-Host 'Folder selection cancelled. No files changed.'; exit 0 }
Write-Host "Selected source: $selectedSource"

$temporaryPassphrase = $false
if (-not $env:PRINT_DRIVE_PASSPHRASE -and -not (Test-Path -LiteralPath (Join-Path $repoRoot '.print-drive-passphrase'))) {
    $secure = Read-Host 'Vault passphrase (kept in this process only)' -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $env:PRINT_DRIVE_PASSPHRASE = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer); $temporaryPassphrase = $true }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

try {
    Write-Host "`nDry-run classification" -ForegroundColor Cyan
    & node scripts/relink_source.mjs --source $selectedSource
    if ($LASTEXITCODE -ne 0) { throw 'Source relink dry-run failed; nothing was applied.' }
    Write-Host "`nChoose an explicitly reviewed action:"
    Write-Host '  A = adopt exact match only (no encrypted vault change)'
    Write-Host '  U = add/replace and preserve remote-only files'
    Write-Host '  M = mirror source and delete remote-only files (dangerous)'
    Write-Host '  Q = quit without applying'
    $choice = (Read-Host 'Action').Trim().ToUpperInvariant()
    switch ($choice) {
        'A' { $modeArguments = @('--adopt') }
        'U' { $modeArguments = @('--add-replace') }
        'M' {
            $confirmation = Read-Host 'Type DELETE_REMOTE_ONLY to authorize every listed remote-only deletion'
            if ($confirmation -cne 'DELETE_REMOTE_ONLY') { throw 'Mirror deletion was not confirmed. No mirror was run.' }
            $modeArguments = @('--mirror', '--confirm-mirror', 'DELETE_REMOTE_ONLY')
        }
        'Q' { Write-Host 'Cancelled. No relink action was applied.'; exit 0 }
        default { throw 'Unknown action. No relink action was applied.' }
    }
    & node scripts/relink_source.mjs --source $selectedSource @modeArguments
    if ($LASTEXITCODE -ne 0) { throw 'Source relink apply failed.' }
    Write-Host "`nRunning repository verification..." -ForegroundColor Cyan
    & npm run verify
    if ($LASTEXITCODE -ne 0) { throw 'Relink completed, but verification failed. Do not push; inspect the output above.' }
    Write-Host "`nRecovery verified. Review 'git status' and the encrypted-only diff before committing." -ForegroundColor Green
}
finally {
    if ($temporaryPassphrase) { Remove-Item Env:PRINT_DRIVE_PASSPHRASE -ErrorAction SilentlyContinue }
}
