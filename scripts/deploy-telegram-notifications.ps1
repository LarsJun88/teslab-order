param(
    [string]$ProjectId = "teslab-order-center"
)

$ErrorActionPreference = "Stop"
$env:NODE_OPTIONS = (($env:NODE_OPTIONS, "--no-deprecation") -join " ").Trim()

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

function Get-TelegramUpdates {
    param(
        [string]$BotToken
    )

    try {
        return Invoke-RestMethod -Method Get -Uri "https://api.telegram.org/bot$BotToken/getUpdates"
    } catch {
        Write-Host ""
        Write-Host "Telegram API could not find that bot token." -ForegroundColor Red
        Write-Host "Check that you pasted the full token from @BotFather." -ForegroundColor Yellow
        Write-Host "The token format should look like: 1234567890:AA..." -ForegroundColor Yellow
        Write-Host "Do not paste the bot username, bot name, or only the text after the colon." -ForegroundColor Yellow
        throw
    }
}

function Test-TelegramBotToken {
    param(
        [string]$BotToken
    )

    try {
        $botInfo = Invoke-RestMethod -Method Get -Uri "https://api.telegram.org/bot$BotToken/getMe"
    } catch {
        Write-Host ""
        Write-Host "Telegram rejected this bot token." -ForegroundColor Red
        Write-Host "Most common causes:" -ForegroundColor Yellow
        Write-Host "- You pasted only part of the token."
        Write-Host "- You pasted the bot username, such as teslab_order_alert_bot."
        Write-Host "- The token was revoked in @BotFather."
        Write-Host "- Extra hidden characters were copied with the token."
        Write-Host ""
        Write-Host "Copy the token again from @BotFather. It must look like 1234567890:AA..." -ForegroundColor Yellow
        throw
    }

    if (-not $botInfo.ok -or -not $botInfo.result) {
        throw "Telegram bot token validation failed."
    }

    Write-Host ""
    Write-Host "Telegram bot token is valid." -ForegroundColor Green
    Write-Host ("Bot username: @{0}" -f $botInfo.result.username)
}

function Show-TelegramChats {
    param(
        [string]$BotToken
    )

    Write-Host ""
    Write-Host "Fetching recent Telegram bot chats..." -ForegroundColor Cyan
    $updates = Get-TelegramUpdates -BotToken $BotToken

    if (-not $updates.ok -or -not $updates.result -or $updates.result.Count -eq 0) {
        Write-Host "No recent chats found. Send /start to the bot in Telegram, then run this script again." -ForegroundColor Red
        exit 1
    }

    $chatRows = $updates.result |
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
        Sort-Object ChatId -Unique

    $chatRows | Format-Table -AutoSize | Out-Host

    return Read-Host "Copy one ChatId from above and paste it here"
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
$botToken = (ConvertTo-PlainText $secureBotToken).Trim()

if ($botToken -notmatch "^\d+:[A-Za-z0-9_-]{20,}$") {
    Write-Host ""
    Write-Host "The Telegram bot token format looks wrong." -ForegroundColor Red
    Write-Host "Paste the full token from @BotFather, like 1234567890:AA..." -ForegroundColor Yellow
    throw "Invalid Telegram bot token format."
}

Test-TelegramBotToken -BotToken $botToken

Write-Host ""
Write-Host "If you do not know the chat ID, leave this blank and the script will show recent bot chats."
$chatId = Read-Host "Telegram chat ID"

if ([string]::IsNullOrWhiteSpace($chatId)) {
    $chatId = [string](Show-TelegramChats -BotToken $botToken)
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
        $chatId = [string](Show-TelegramChats -BotToken $botToken)
    }
}

Write-Host ""
Write-Host "Saving Firebase secrets..." -ForegroundColor Cyan
Set-FirebaseSecretFromValue -Name "TELEGRAM_BOT_TOKEN" -Value $botToken
Set-FirebaseSecretFromValue -Name "TELEGRAM_CHAT_ID" -Value $chatId.Trim()

Write-Host ""
Write-Host "Deploying Cloud Function..." -ForegroundColor Cyan
$deployLog = Join-Path $RepoRoot "firebase-deploy.log"
npx firebase-tools deploy --only functions:notifyTelegramOnOrderCreated --project $ProjectId --debug 2>&1 |
    Tee-Object -FilePath $deployLog

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Firebase function deploy failed." -ForegroundColor Red
    Write-Host "Full deploy log saved to: $deployLog" -ForegroundColor Yellow
    Write-Host "Open that file and check the last error block, or paste the last 40 lines here." -ForegroundColor Yellow
    throw "Firebase function deploy failed. See firebase-deploy.log"
}

Write-Host ""
Write-Host "Done. New Firestore orders will now send Telegram notifications." -ForegroundColor Green
