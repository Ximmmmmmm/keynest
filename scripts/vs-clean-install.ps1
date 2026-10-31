$ErrorActionPreference = 'Continue'
$log = 'C:\Users\XIM\AppData\Local\Temp\vs-clean.log'
function Log($m) { $m | Out-File $log -Append -Encoding utf8 }
"=== $(Get-Date -Format o) ===" | Out-File $log -Encoding utf8

# 1) 先卸掉残缺实例
$setup = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe'
Log '--- uninstall 残缺实例 ---'
$p = Start-Process -FilePath $setup -ArgumentList 'uninstall','--quiet','--wait','--norestart' -Wait -PassThru
Log "uninstall exit: $($p.ExitCode)"

# 2) 等安装器退出
Start-Sleep -Seconds 5
Get-Process -Name 'setup','vs_installer','vs_installershell' -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Start-Sleep -Seconds 3

# 3) 用 bootstrapper 全新安装（明确指定工作负载 + 组件）
$boot = 'C:\Users\XIM\AppData\Local\Temp\vs_community.exe'
$argList = @(
  '--quiet', '--wait', '--norestart', '--nocache',
  '--add', 'Microsoft.VisualStudio.Workload.VCTools',
  '--add', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  '--add', 'Microsoft.VisualStudio.Component.Windows11SDK.22621'
)
Log "--- 全新安装 ---"
Log "参数: $($argList -join ' ')"
$p2 = Start-Process -FilePath $boot -ArgumentList $argList -Wait -PassThru
Log "install exit: $($p2.ExitCode)"

# 4) 验证
$link = Get-ChildItem 'C:\Program Files (x86)\Microsoft Visual Studio','C:\Program Files\Microsoft Visual Studio' -Recurse -Filter 'link.exe' -EA SilentlyContinue |
  Where-Object { $_.FullName -like '*Hostx64*x64*' } | Select-Object -First 1
if ($link) { Log "FOUND: $($link.FullName)" } else { Log 'NO link.exe' }

Get-Content $log -Raw
