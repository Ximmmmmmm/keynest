<#
.SYNOPSIS
    开发用：把 KeyNest Native Messaging Host 注册到本机 Chrome / Edge。

.DESCRIPTION
    这不是正式安装器。正式安装要等扩展 ID 由商店分配之后再做，
    原因见 docs/browser-integration-architecture.md 第 7.2 节：
    「不要猜测正式扩展 ID」。

    开发者模式加载解包扩展后，浏览器地址栏 chrome://extensions 会显示该扩展的 ID，
    把它作为 -ChromeId / -EdgeId 传进来即可。两个 ID 通常相同（同一份代码），
    但允许不同，所以分开传。

.PARAMETER HostExe
    keynest-native-host.exe 的绝对路径。

.PARAMETER ChromeId
    Chrome 里该扩展的 ID（32 个 a-p 字母）。省略则不注册 Chrome。

.PARAMETER EdgeId
    Edge 里该扩展的 ID。省略则不注册 Edge。

.PARAMETER ManifestDir
    manifest 存放目录。默认 %LOCALAPPDATA%\KeyNest。
    隔离测试时传临时目录，测试结束后 -Uninstall 会一并删除该 manifest。
    脚本只会删除自己写的那一个 com.keynest.bridge.json，不动目录里其他文件。

.PARAMETER Uninstall
    只删除本脚本创建的注册项与清单文件，不碰 vault.dat、不碰其它软件写的项。

.EXAMPLE
    .\register-native-host-dev.ps1 -HostExe "G:\Scripts\keynest\rust\target\debug\keynest-native-host.exe" -ChromeId "abcdefghijklmnopabcdefghijklmnop"
#>

[CmdletBinding()]
param(
    [string]$HostExe,
    [string]$ChromeId,
    [string]$EdgeId,
    # manifest 存放目录。默认与 Rust 侧数据目录约定一致；
    # 隔离测试时传临时目录，避免污染真实 %LOCALAPPDATA%\KeyNest。
    [string]$ManifestDir,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

# 默认行为不变：不传 -ManifestDir 时仍是 %LOCALAPPDATA%\KeyNest
if (-not $ManifestDir) {
    $ManifestDir = Join-Path $env:LOCALAPPDATA 'KeyNest'
}
$DataDir  = $ManifestDir
$Manifest = Join-Path $DataDir 'com.keynest.bridge.json'

function Remove-OurRegistry {
    foreach ($base in 'Software\Google\Chrome\NativeMessagingHosts',
                      'Software\Microsoft\Edge\NativeMessagingHosts') {
        $key = "HKCU:\$base\com.keynest.bridge"
        if (Test-Path $key) {
            Remove-Item $key -Recurse -Force
            Write-Host "已删除注册项：$key"
        }
    }
}

if ($Uninstall) {
    Remove-OurRegistry
    if (Test-Path $Manifest) {
        Remove-Item $Manifest -Force
        Write-Host "已删除清单：$Manifest"
    }
    Write-Host "完成。注意：密码库与备份文件未被触碰。" -ForegroundColor Green
    return
}

if (-not $HostExe) { Write-Error "必须提供 -HostExe"; return }
if (-not (Test-Path $HostExe)) { Write-Error "找不到 HostExe：$HostExe"; return }

$HostExe = (Resolve-Path $HostExe).Path

if (-not $ChromeId -and -not $EdgeId) {
    Write-Error "至少要提供 -ChromeId 或 -EdgeId。不允许猜测 ID：未登记的扩展本来就应连不上。"
    return
}

foreach ($id in @($ChromeId, $EdgeId)) {
    if ($id -and $id -notmatch '^[a-p]{32}$') {
        Write-Error "扩展 ID 格式不对：$id（应为 32 个 a-p 字母）"
        return
    }
}

if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
}

# 清单：只登记明确传入的 ID，不塞通配符
$origins = @()
if ($ChromeId) { $origins += "chrome-extension://$ChromeId/" }
if ($EdgeId)   { $origins += "chrome-extension://$EdgeId/" }

$manifestObj = [ordered]@{
    name              = 'com.keynest.bridge'
    description       = 'KeyNest Browser Bridge'
    path              = $HostExe
    type              = 'stdio'
    allowed_origins   = $origins
}
$json = $manifestObj | ConvertTo-Json -Depth 4

# 原子写入：先 .tmp 再改名，避免浏览器读到半截清单
$tmp = "$Manifest.tmp"
Set-Content -Path $tmp -Value $json -Encoding UTF8 -Force
Move-Item -Path $tmp -Destination $Manifest -Force
Write-Host "清单已写入：$Manifest"

# 注册表：HKCU，不需要管理员权限
function Register-Host([string]$regRoot, [string]$label, [string]$id) {
    if (-not $id) { return }
    $key = "HKCU:\$regRoot\com.keynest.bridge"
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(default)' -Value $Manifest
    Write-Host "已注册 $label：$key"
}

try {
    Register-Host 'Software\Google\Chrome\NativeMessagingHosts' 'Chrome' $ChromeId
    Register-Host 'Software\Microsoft\Edge\NativeMessagingHosts' 'Edge'   $EdgeId
} catch {
    # 注册失败要回滚自己写的内容，不留半截状态
    Write-Warning "注册失败，正在回滚：$_"
    Remove-OurRegistry
    if (Test-Path $Manifest) { Remove-Item $Manifest -Force }
    throw
}

Write-Host ""
Write-Host "完成。下一步：" -ForegroundColor Green
Write-Host "  1) 启动 KeyNest 并解锁密码库（桥接服务只在解锁后运行）"
Write-Host "  2) 在 chrome://extensions 加载 browser-extension/ 目录（开发者模式）"
Write-Host "  3) 打开一个 https 登录页，点扩展图标"
