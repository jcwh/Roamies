@echo off
rem Starts the Roamies speech server. Run it from a terminal where Python has the packages in requirements.txt
rem (for example after "conda activate roamies-speech"), or double-click it if they're in your everyday Python.
cd /d "%~dp0"
python roamies_speech_server.py %*
echo.
echo The speech server has stopped.
pause
