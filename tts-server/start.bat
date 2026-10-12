@echo off
rem Starts the local server for the Manga Reader extension (Kokoro voices and
rem the speech-bubble detector).
cd /d "%~dp0"
set HF_HUB_DISABLE_SYMLINKS_WARNING=1
python local_server.py
pause
