@echo off
rem Starts the local Kokoro TTS server for the Manga Reader extension.
cd /d "%~dp0"
set HF_HUB_DISABLE_SYMLINKS_WARNING=1
python kokoro_server.py
pause
