$ErrorActionPreference = 'Continue'
$log = "$env:TEMP\vs-add.log"
$done = "$env:TEMP\vs-add.done"
Remove-Item $done -EA SilentlyContinue
"=== $(Get-Date -Format o) ===" | Out-File $log -Encoding utf8

$setup = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe'
$installPath = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools'

# 用 setup.exe modify 补装核心 C++ 组件
$argList = @(
  'modify',
  "--installPath=$installPath",
  '--quiet',
  '--wait',
  '--norestart',
  '--add', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  '--add', 'Microsoft.VisualStudio.Component.Windows11SDK.22621'
)

"执行 setup.exe $($argList -join ' ')" | Out-File $log -Append -Encoding utf8
$p = Start-Process -FilePath $setup -ArgumentList $argList -Wait -PassThru
"exit: $($p.ExitCode)" | Out-File $log -Append -Encoding utf8

$link = Get-ChildItem 'C:\Program Files (x86)\Microsoft Visual Studio\2022' -Recurse -Filter 'link.exe' -EA SilentlyContinue |
  Where-Object { $_.FullName -like '*Hostx64*x64*' } | Select-Object -First 1
if ($link) { "FOUND: $($link.FullName)" | Out-File $log -Append -Encoding utf8 }
else { 'NO link.exe' | Out-File $log -Append -Encoding utf8 }

"DONE $($p.ExitCode)" | Out-File $done -Encoding utf8
Get-Content $log -Raw
