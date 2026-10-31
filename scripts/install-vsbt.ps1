$ErrorActionPreference = 'Continue'
$log = 'C:\Users\XIM\AppData\Local\Temp\vs-bt.log'
$done = 'C:\Users\XIM\AppData\Local\Temp\vs-bt.done'
Remove-Item $done -EA SilentlyContinue
"=== $(Get-Date -Format o) ===" | Out-File $log -Encoding utf8

$bootstrapper = 'C:\Users\XIM\AppData\Local\Temp\vs_buildtools.exe'

$argList = @(
  '--quiet',
  '--wait',
  '--norestart',
  '--nocache',
  '--includeRecommended',
  '--add=Microsoft.VisualStudio.Workload.VCTools',
  '--add=Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  '--add=Microsoft.VisualStudio.Component.Windows11SDK.26100'
)

"启动: $bootstrapper" | Out-File $log -Append -Encoding utf8
$p = Start-Process -FilePath $bootstrapper -ArgumentList $argList -Wait -PassThru
"exit: $($p.ExitCode)" | Out-File $log -Append -Encoding utf8

$link = Get-ChildItem 'C:\Program Files (x86)\Microsoft Visual Studio' -Recurse -Filter 'link.exe' -EA SilentlyContinue |
  Where-Object { $_.FullName -like '*Hostx64*x64*' } | Select-Object -First 1
if ($link) { "FOUND: $($link.FullName)" | Out-File $log -Append -Encoding utf8 }
else { 'NO link.exe' | Out-File $log -Append -Encoding utf8 }

"DONE $($p.ExitCode)" | Out-File $done -Encoding utf8
Get-Content $log -Raw
