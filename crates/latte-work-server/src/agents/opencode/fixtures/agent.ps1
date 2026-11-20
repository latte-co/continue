# Native Windows metadata peer for the same export cases as opencode.py.
if ($args.Count -ne 4 -or $args[0] -ne 'session' -or $args[1] -ne 'export' -or $args[2] -ne '--standalone') {
    exit 2
}
$record = Join-Path (Get-Location) ($args[3] + '.json')
if (-not (Test-Path -LiteralPath $record -PathType Leaf)) { exit 1 }
[Console]::Out.Write([System.IO.File]::ReadAllText($record))
