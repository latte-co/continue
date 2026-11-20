# Trusted launch code; target and every argument arrive only as separate argv.
$encoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $encoding
[Console]::OutputEncoding = $encoding
$OutputEncoding = $encoding
$PSNativeCommandArgumentPassing = 'Standard'
$target = $args[0]
$forwarded = @()
if ($args.Count -gt 1) { $forwarded = @($args[1..($args.Count - 1)]) }
& $target @forwarded
$succeeded = $?
if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (-not $succeeded) { exit 1 }
exit 0
