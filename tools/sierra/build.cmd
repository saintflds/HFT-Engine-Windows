@echo off
setlocal
cd /d "%~dp0"
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 exit /b 1
if not exist build mkdir build
cl.exe /nologo /std:c++17 /EHsc /O2 /MT /LD /I"..\..\..\SierraChart\ACS_Source" HFTEngineLive.cpp /Fo"build\HFTEngineLive.obj" /link /OUT:"build\HFTEngineLive_64.dll" /IMPLIB:"build\HFTEngineLive_64.lib"
exit /b %errorlevel%
