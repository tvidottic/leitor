@echo off
title Leitor
cd /d "%~dp0"
echo Iniciando o Leitor em http://localhost:8787 ...
echo Feche esta janela para encerrar o servidor.
start "" "http://localhost:8787"
python serve.py 8787
if errorlevel 1 (
  echo.
  echo Python nao encontrado. Instale em https://www.python.org/downloads/ e marque "Add to PATH".
  pause
)
