@echo off
rem Windows: double-click this file. Close this window to stop the site.
cd /d "%~dp0clubportal"
set PY=python
where python >nul 2>nul || set PY=py
if not exist portal.db %PY% seed.py
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8770"
%PY% app.py
pause
