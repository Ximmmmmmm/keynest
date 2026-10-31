$ErrorActionPreference = 'Continue'
$log = 'C:\Users\XIM\AppData\Local\Temp\winsdk.log'
$done = 'C:\Users\XIM\AppData\Local\Temp\winsdk.done'
Remove-Item $done -EA SilentlyContinue
"=== $(Get-Date -Format o) ===" | Out-File $log -Encoding utf8

$installer = 'C:\Users\XIM\AppData\Local\Temp\winsdk.exe'
"安装器存在: $(Test-Path $installer)" | Out-File $log -Append -Encoding utf8

# winsdksetup.exe 支持 /features 指定组件
# OptionId.WindowsDesktopSoftwareDevelopmentKit 包含 kernel32.lib 等 um libs
$argList = @(
  '/quiet',
  '/norestart',
  '/features',
  'OptionId.WindowsDesktopSoftwareDevelopmentKit'
)

"参数: $($argList -join ' ')" | Out-File $log -Append -Encoding utf8
$p = Start-Process -FilePath $installer -ArgumentList $argList -Wait -PassThru
"exit: $($p.ExitCode)" | Out-File $log -Append -Encoding utf8

# 验证
Start-Sleep -Seconds 3
$lib = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\Lib' -Recurse -Filter 'kernel32.lib' -EA SilentlyContinue | Select-Object -First 1
if ($lib) { "FOUND: $($lib.FullName)" | Out-File $log -Append -Encoding utf8 }
else { 'NO kernel32.lib' | Out-File $log -Append -Encoding utf8 }

"DONE" | Out-File $done -Encoding utf8
Get-Content $log -Raw
