$ErrorActionPreference = 'Continue'
$log = "$env:TEMP\vs-bt2.log"
$done = "$env:TEMP\vs-bt2.done"
Remove-Item $done -EA SilentlyContinue
"=== $(Get-Date -Format o) ===" | Out-File $log -Encoding utf8

$boot = "$env:TEMP\vs_buildtools.exe"

# 最简参数：只装 C++ 工具链，SDK 由 includeRecommended 自动带
$argList = @(
  '--quiet',
  '--wait',
  '--norestart',
  '--includeRecommended',
  '--add', 'Microsoft.VisualStudio.Workload.VCTools'
)

"参数: $($argList -join ' ')" | Out-File $log -Append -Encoding utf8

$p = Start-Process -FilePath $boot -ArgumentList $argList -Wait -PassThru
"exit: $($p.ExitCode)" | Out-File $log -Append -Encoding utf8

# 无论成败都查一遍
$link = Get-ChildItem 'C:\Program Files (x86)\Microsoft Visual Studio','C:\Program Files\Microsoft Visual Studio' -Recurse -Filter 'link.exe' -EA SilentlyContinue |
  Where-Object { $_.FullName -like '*Hostx64*x64*' } | Select-Object -First 1
if ($link) { "FOUND: $($link.FullName)" | Out-File $log -Append -Encoding utf8 }
else { 'NO link.exe' | Out-File $log -Append -Encoding utf8 }

"DONE $($p.ExitCode)" | Out-File $done -Encoding utf8
Get-Content $log -Raw
