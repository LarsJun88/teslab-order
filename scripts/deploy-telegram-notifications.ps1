param(
    [string]$ProjectId = "teslab-order-center"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir

function ConvertTo-PlainText {
    param(
        [System.Security.SecureString]$SecureValue
    )

    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function Set-FirebaseSecretFromValue {
    param(
        [string]$Name,
        [string]$Value
    )

    $tempFile = New-TemporaryFile

    try {
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($tempFile.FullName, $Value, $utf8NoBom)

        npx firebase-tools functions:secrets:set $Name `
            --project $ProjectId `
            --data-file $tempFile.FullName

        if ($LASTEXITCODE -ne 0) {
            throw "Failed to set Firebase secret: $Name"
        }
    } finally {
        Remove-Item -LiteralPath $tempFile.FullName -Force -ErrorAction SilentlyContinue
    }
}

Set-Location $RepoRoot

Write-Host ""
Write-Host "== Teslab Telegram order notification deploy ==" -ForegroundColor Cyan
Write-Host "Firebase project: $ProjectId"
Write-Host ""

$loginListOutput = npx firebase-tools login:list --project $ProjectId 2>&1 | Out-String
Write-Host $loginListOutput

if ($LASTEXITCODE -ne 0 -or $loginListOutput -match "No authorized accounts") {
    Write-Host ""
    Write-Host "Firebase login is required. A browser login window will open." -ForegroundColor Yellow
    npx firebase-tools login
    if ($LASTEXITCODE -ne 0) {
        throw "Firebase login failed."
    }
}

Push-Location (Join-Path $RepoRoot "functions")
try {
    npm install
    npm run lint
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "Create a Telegram bot with @BotFather, then send /start to that bot." -ForegroundColor Yellow
$secureBotToken = Read-Host "Paste Telegram bot token" -AsSecureString
$botToken = ConvertTo-PlainText $secureBotToken

Write-Host ""
Write-Host "If you do not know the chat ID, leave this blank and the script will show recent bot chats."
$chatId = Read-Host "Telegram chat ID"

if ([string]::IsNullOrWhiteSpace($chatId)) {
    Write-Host ""
    Write-Host "Fetching recent Telegram bot chats..." -ForegroundColor Cyan
    $updates = Invoke-RestMethod -Method Get -Uri "https://api.telegram.org/bot$botToken/getUpdates"

    if (-not $updates.ok -or -not $updates.result -or $updates.result.Count -eq 0) {
        Write-Host "No recent chats found. Send /start to the bot in Telegram, then run this script again." -ForegroundColor Red
        exit 1
    }

    $updates.result |
        ForEach-Object {
            $message = if ($_.message) { $_.message } elseif ($_.channel_post) { $_.channel_post } else { $null }
            if ($message -and $message.chat) {
                [PSCustomObject]@{
                    ChatId = $message.chat.id
                    Type = $message.chat.type
                    Title = $message.chat.title
                    Username = $message.chat.username
                    FirstName = $message.chat.first_name
                }
            }
        } |
        Sort-Object ChatId -Unique |
        Format-Table -AutoSize

    $chatId = Read-Host "Copy one ChatId from above and paste it here"
}

if ([string]::IsNullOrWhiteSpace($chatId)) {
    throw "Telegram chat ID is required."
}

while ($chatId.Trim() -notmatch "^-?\d+$") {
    Write-Host ""
    Write-Host "Telegram chat ID must be a number, like 123456789 or -1001234567890." -ForegroundColor Yellow
    Write-Host "Do not paste the bot token here. Leave it blank to show recent bot chats."
    $chatId = Read-Host "Telegram chat ID"

    if ([string]::IsNullOrWhiteSpace($chatId)) {
        Write-Host ""
        Write-Host "Fetching recent Telegram bot chats..." -ForegroundColor Cyan
        $updates = Invoke-RestMethod -Method Get -Uri "https://api.telegram.org/bot$botToken/getUpdates"

        if (-not $updates.ok -or -not $updates.result -or $updates.result.Count -eq 0) {
            Write-Host "No recent chats found. Send /start to the bot in Telegram, then run this script again." -ForegroundColor Red
            exit 1
        }

        $updates.result |
            ForEach-Object {
                $message = if ($_.message) { $_.message } elseif ($_.channel_post) { $_.channel_post } else { $null }
                if ($message -and $message.chat) {
                    [PSCustomObject]@{
                        ChatId = $message.chat.id
                        Type = $message.chat.type
                        Title = $message.chat.title
                        Username = $message.chat.username
                        FirstName = $message.chat.first_name
                    }
                }
            } |
            Sort-Object ChatId -Unique |
            Format-Table -AutoSize

        $chatId = Read-Host "Copy one ChatId from above and paste it here"
    }
}

Write-Host ""
Write-Host "Saving Firebase secrets..." -ForegroundColor Cyan
Set-FirebaseSecretFromValue -Name "TELEGRAM_BOT_TOKEN" -Value $botToken
Set-FirebaseSecretFromValue -Name "TELEGRAM_CHAT_ID" -Value $chatId.Trim()

Write-Host ""
Write-Host "Deploying Cloud Function..." -ForegroundColor Cyan
npx firebase-tools deploy --only functions:notifyTelegramOnOrderCreated --project $ProjectId
if ($LASTEXITCODE -ne 0) {
    throw "Firebase function deploy failed."
}

Write-Host ""
Write-Host "Done. New Firestore orders will now send Telegram notifications." -ForegroundColor Green
