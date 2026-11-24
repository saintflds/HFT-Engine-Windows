param([string]$Python = "python")
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$environmentPython = Join-Path $projectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $environmentPython)) {
    & $Python -m venv (Join-Path $projectRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the local Python environment.' }
}
& $environmentPython -m pip install --disable-pip-version-check --no-cache-dir --only-binary=:all: --index-url https://pypi.org/simple -r (Join-Path $PSScriptRoot 'requirements-sierra.txt')
if ($LASTEXITCODE -ne 0) { throw 'Could not install the pinned NumPy wheel. This setup was tested with Python 3.15.1 on Windows x64.' }
& $environmentPython -c "import sys, numpy; print('Ready:', sys.executable); print('NumPy:', numpy.__version__)"
if ($LASTEXITCODE -ne 0) { throw 'The local Python environment did not pass its import check.' }
Write-Output 'Sierra conversion/tests use the standard library. This environment also supports tools/hbr.py.'
