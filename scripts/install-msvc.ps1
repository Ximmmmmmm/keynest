$ErrorActionPreference = 'Continue'
$log = 'C:\Users\XIM\AppData\Local\Temp\vs-install.log'
"=== $(Get-Date -Format o) ===" | Out-File $log -Encoding utf8

# 只装最小可用的 C++ 工具链（Tauri 编译需要 link.exe + Windows SDK）
$components = @(
  'Microsoft.VisualStudio.Workload.VCTools',
  'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  'Microsoft.VisualStudio.Component.Windows11SDK.26100',
  'Microsoft.VisualStudio.Component.VC.ATL'
)

$vsInstaller = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe'

if (-not (Test-Path $vsInstaller)) {
  "VS Installer 不存在: $vsInstaller" | Out-File $log -Append -Encoding utf8
  Get-Content $log -Raw
  exit 1
}

$argList = @(
  'modify',
  '--quiet',
  '--wait',
  '--norestart',
  '--nocache'
)
foreach ($c in $components) { $argList += "--add=$c" }

"执行: $vsInstaller $($argList -join ' ')" | Out-File $log -Append -Encoding utf8

$p = Start-Process -FilePath $vsInstaller -ArgumentList $argList -Wait -PassThru
"exit: $($p.ExitCode)" | Out-File $log -Append -Encoding utf8

# 验证 link.exe 是否出现
$link = Get-ChildItem 'C:\Program Files (x86)\Microsoft Visual Studio' -Recurse -Filter 'link.exe' -EA SilentlyContinue |
  Where-Object { $_.FullName -like '*Hostx64*x64*' } | Select-Object -First 1
if ($link) {
  "FOUND link.exe: $($link.FullName)" | Out-File $log -Append -Encoding utf8
} else {
  'NO link.exe found' | Out-File $log -Append -Encoding utf8
}

Get-Content $log -Raw
