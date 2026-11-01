$ErrorActionPreference = 'Continue'
$log = "$env:TEMP\vs-add2.log"
$done = "$env:TEMP\vs-add2.done"
Remove-Item $done -EA SilentlyContinue
"=== $(Get-Date -Format o) ===" | Out-File $log -Encoding utf8

$setup = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe'

# 用 channelId + productId 定位已装产品（installationId 为空时的正确做法）
$argList = @(
  'modify',
  '--channelId', 'VisualStudio.17.Release',
  '--productId', 'Microsoft.VisualStudio.Product.BuildTools',
  '--quiet',
  '--wait',
  '--norestart',
  '--add', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'
)

"参数: $($argList -join ' ')" | Out-File $log -Append -Encoding utf8
$p = Start-Process -FilePath $setup -ArgumentList $argList -Wait -PassThru
"exit: $($p.ExitCode)" | Out-File $log -Append -Encoding utf8

# 若 87，改试 includeRecommended
if ($p.ExitCode -ne 0) {
  "重试 includeRecommended" | Out-File $log -Append -Encoding utf8
  $argList2 = @(
    'modify',
    '--channelId', 'VisualStudio.17.Release',
    '--productId', 'Microsoft.VisualStudio.Product.BuildTools',
    '--quiet', '--wait', '--norestart',
    '--includeRecommended'
  )
  $p2 = Start-Process -FilePath $setup -ArgumentList $argList2 -Wait -PassThru
  "retry exit: $($p2.ExitCode)" | Out-File $log -Append -Encoding utf8
}

$link = Get-ChildItem 'C:\Program Files (x86)\Microsoft Visual Studio\2022' -Recurse -Filter 'link.exe' -EA SilentlyContinue |
  Where-Object { $_.FullName -like '*Hostx64*x64*' } | Select-Object -First 1
if ($link) { "FOUND: $($link.FullName)" | Out-File $log -Append -Encoding utf8 }
else { 'NO link.exe' | Out-File $log -Append -Encoding utf8 }

"DONE" | Out-File $done -Encoding utf8
Get-Content $log -Raw
