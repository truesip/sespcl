# TrueSIP Hybrid API - DigitalOcean Deployment Helper
# PowerShell script to prepare and deploy your SIP-enabled voice API

Write-Host "🚀 TrueSIP Hybrid API Deployment Helper" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green

# Check if git is available
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Git is not installed or not in PATH" -ForegroundColor Red
    Write-Host "Please install Git and try again: https://git-scm.com/download/win"
    exit 1
}

# Get GitHub repository details
Write-Host "\n📂 GitHub Repository Setup" -ForegroundColor Yellow
$githubUsername = Read-Host "Enter your GitHub username"
$repoName = Read-Host "Enter repository name (e.g., truesip-hybrid-api)"

if ([string]::IsNullOrWhiteSpace($githubUsername) -or [string]::IsNullOrWhiteSpace($repoName)) {
    Write-Host "❌ GitHub username and repository name are required" -ForegroundColor Red
    exit 1
}

# Update app.yaml with GitHub details
Write-Host "\n🔧 Updating app.yaml configuration..." -ForegroundColor Yellow
$appYamlPath = ".do\app.yaml"
if (Test-Path $appYamlPath) {
    $content = Get-Content $appYamlPath -Raw
    $content = $content -replace 'repo: your-github-username/your-repo-name', "repo: $githubUsername/$repoName"
    Set-Content $appYamlPath $content
    Write-Host "✅ Updated $appYamlPath with your repository details" -ForegroundColor Green
} else {
    Write-Host "⚠️  app.yaml not found at $appYamlPath" -ForegroundColor Yellow
}

# Check if already a git repository
if (-not (Test-Path ".git")) {
    Write-Host "\n📦 Initializing Git repository..." -ForegroundColor Yellow
    git init
    Write-Host "✅ Git repository initialized" -ForegroundColor Green
} else {
    Write-Host "\n📦 Git repository already exists" -ForegroundColor Green
}

# Add remote if not exists
$remoteUrl = "https://github.com/$githubUsername/$repoName.git"
try {
    $existingRemote = git remote get-url origin 2>$null
    if ($existingRemote -ne $remoteUrl) {
        Write-Host "\n🔗 Updating GitHub remote..." -ForegroundColor Yellow
        git remote set-url origin $remoteUrl
    } else {
        Write-Host "\n🔗 GitHub remote already configured" -ForegroundColor Green
    }
} catch {
    Write-Host "\n🔗 Adding GitHub remote..." -ForegroundColor Yellow
    git remote add origin $remoteUrl
}

# Check git status
Write-Host "\n📋 Current Git Status:" -ForegroundColor Yellow
git status --short

# Ask if user wants to commit and push
Write-Host "\n📤 Ready to commit and push to GitHub?" -ForegroundColor Yellow
$shouldPush = Read-Host "Commit and push? (y/N)"

if ($shouldPush -eq 'y' -or $shouldPush -eq 'Y') {
    Write-Host "\n📝 Staging all files..." -ForegroundColor Yellow
    git add .
    
    $commitMessage = Read-Host "Enter commit message (or press Enter for default)"
    if ([string]::IsNullOrWhiteSpace($commitMessage)) {
        $commitMessage = "Deploy TrueSIP Hybrid API with SIP routing capabilities"
    }
    
    Write-Host "\n💾 Committing changes..." -ForegroundColor Yellow
    git commit -m $commitMessage
    
    Write-Host "\n📤 Pushing to GitHub..." -ForegroundColor Yellow
    try {
        git push -u origin main
        Write-Host "✅ Successfully pushed to GitHub!" -ForegroundColor Green
    } catch {
        Write-Host "❌ Failed to push to GitHub. You may need to:" -ForegroundColor Red
        Write-Host "   1. Create the repository on GitHub first" -ForegroundColor Yellow
        Write-Host "   2. Authenticate with GitHub (git config or GitHub CLI)" -ForegroundColor Yellow
        Write-Host "   3. Manually run: git push -u origin main" -ForegroundColor Yellow
    }
} else {
    Write-Host "\n⏸️  Skipping push. You can manually run:" -ForegroundColor Yellow
    Write-Host "   git add ." -ForegroundColor Cyan
    Write-Host "   git commit -m 'Deploy TrueSIP Hybrid API'" -ForegroundColor Cyan
    Write-Host "   git push -u origin main" -ForegroundColor Cyan
}

# Display next steps
Write-Host "\n\n🎯 Next Steps:" -ForegroundColor Green
Write-Host "================" -ForegroundColor Green
Write-Host "1. Create repository on GitHub: https://github.com/new" -ForegroundColor White
Write-Host "   Repository name: $repoName" -ForegroundColor Cyan
Write-Host "\n2. Go to DigitalOcean App Platform:" -ForegroundColor White
Write-Host "   https://cloud.digitalocean.com/apps" -ForegroundColor Cyan
Write-Host "\n3. Create new app and connect to:" -ForegroundColor White
Write-Host "   $remoteUrl" -ForegroundColor Cyan
Write-Host "\n4. Upload the .do/app.yaml configuration file" -ForegroundColor White
Write-Host "\n5. Set environment variables:" -ForegroundColor White
Write-Host "   - MY_API_KEY (generate a secure random key)" -ForegroundColor Cyan
Write-Host "   - DEFAULT_CALLER_ID (your phone number)" -ForegroundColor Cyan
Write-Host "   - SIP_PROXY_HOST, SIP_USERNAME, SIP_PASSWORD, SIP_DOMAIN" -ForegroundColor Cyan
Write-Host "\n6. Deploy and test!" -ForegroundColor White

Write-Host "\n📖 For detailed instructions, see:" -ForegroundColor Yellow
Write-Host "   DIGITALOCEAN_DEPLOYMENT.md" -ForegroundColor Cyan

Write-Host "\n🎉 Setup complete! Your code is ready for DigitalOcean deployment." -ForegroundColor Green

Read-Host "\nPress Enter to exit"
