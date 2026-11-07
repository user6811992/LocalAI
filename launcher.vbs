Set WshShell = CreateObject("WScript.Shell")
base = "C:\Users\Poonjab\Documents\LocalAI"
ollamaDir = "C:\Users\Poonjab\AppData\Local\Programs\Ollama"
ghidraDir = "C:\Ghidra\ghidra_12.1.4_PUBLIC"
jdkDir = "C:\Program Files\Eclipse Adoptium\jdk-21.0.13.9-hotspot"

' Env vars
WshShell.Environment("Process")("OLLAMA_HOST") = "0.0.0.0"
WshShell.Environment("Process")("OLLAMA_ORIGINS") = "*"
WshShell.Environment("Process")("OLLAMA_NO_ANALYTICS") = "1"
WshShell.Environment("Process")("OLLAMA_NO_CLOUD") = "1"
WshShell.Environment("Process")("OLLAMA_NO_UPDATE_CHECK") = "1"
WshShell.Environment("Process")("DO_NOT_TRACK") = "1"
WshShell.Environment("Process")("HF_HUB_DISABLE_TELEMETRY") = "1"
WshShell.Environment("Process")("DISABLE_TELEMETRY") = "1"
WshShell.Environment("Process")("OLLAMA_NOHISTORY") = "true"
WshShell.Environment("Process")("GHIDRA_INSTALL_DIR") = ghidraDir
WshShell.Environment("Process")("JAVA_HOME") = jdkDir
WshShell.Environment("Process")("REA_JADX_MCP_JAR") = "C:\Tools\jadx-mcp\jadx-headless-mcp-0.7.1-all.jar"
WshShell.Environment("Process")("PATH") = "C:\jadx\bin;" & ghidraDir & ";" & jdkDir & "\bin;" & ollamaDir & ";" & "C:\Program Files\nodejs;C:\Users\Poonjab\AppData\Roaming\npm;" & WshShell.Environment("Process")("PATH")

' Start Ollama serve hidden
WshShell.Run """" & ollamaDir & "\ollama.exe"" serve", 0, False

' Wait then start web UI
WScript.Sleep 5000
WshShell.Run "cmd /c cd /d """ & base & """ && node server.js", 0, False
WScript.Sleep 1000
