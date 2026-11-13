' AegisAI launcher (Windows Script Host / standard Windows shell)
' Portable: resolves paths relative to this script.
Option Explicit
On Error Resume Next

Dim wshShell, fso, base, ollamaDir
Set wshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)
If base = "" Then base = wshShell.ExpandEnvironmentStrings("%USERPROFILE%") & "\Documents\LocalAI"

' Discover Ollama
ollamaDir = wshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Ollama"
If Not fso.FileExists(ollamaDir & "\ollama.exe") Then
  Dim exec, out
  Set exec = wshShell.Exec("cmd /c where ollama 2>nul")
  out = exec.StdOut.ReadAll()
  If Len(Trim(out)) > 0 Then
    ollamaDir = fso.GetParentFolderName(Trim(Split(out, vbCrLf)(0)))
  Else
    ollamaDir = "C:\Program Files\Ollama"
  End If
End If

' Env vars
wshShell.Environment("Process")("OLLAMA_HOST") = "127.0.0.1"
wshShell.Environment("Process")("OLLAMA_ORIGINS") = "http://127.0.0.1:8080,http://localhost:8080"
wshShell.Environment("Process")("OLLAMA_NO_ANALYTICS") = "1"
wshShell.Environment("Process")("OLLAMA_NO_CLOUD") = "1"
wshShell.Environment("Process")("OLLAMA_NO_UPDATE_CHECK") = "1"
wshShell.Environment("Process")("DO_NOT_TRACK") = "1"
wshShell.Environment("Process")("HF_HUB_DISABLE_TELEMETRY") = "1"
wshShell.Environment("Process")("DISABLE_TELEMETRY") = "1"
wshShell.Environment("Process")("OLLAMA_NOHISTORY") = "true"
If wshShell.Environment("Process")("GHIDRA_INSTALL_DIR") = "" Then wshShell.Environment("Process")("GHIDRA_INSTALL_DIR") = ""
If wshShell.Environment("Process")("JAVA_HOME") = "" Then wshShell.Environment("Process")("JAVA_HOME") = ""
If wshShell.Environment("Process")("REA_JADX_MCP_JAR") = "" Then wshShell.Environment("Process")("REA_JADX_MCP_JAR") = "C:\Tools\jadx-mcp\jadx-headless-mcp-0.7.1-all.jar"
wshShell.Environment("Process")("PATH") = "C:\jadx\bin;" & wshShell.Environment("Process")("GHIDRA_INSTALL_DIR") & ";" & wshShell.Environment("Process")("JAVA_HOME") & "\bin;" & ollamaDir & ";" & "C:\Program Files\nodejs;" & wshShell.ExpandEnvironmentStrings("%APPDATA%") & "\npm;" & wshShell.Environment("Process")("PATH")

' ---------- Backend selection (from backend.txt written by installer) ----------
Dim backendType, backendUrl
backendType = "ollama"
backendUrl = "http://127.0.0.1:11434"
Dim backendFile
backendFile = base & "\backend.txt"
If fso.FileExists(backendFile) Then
  On Error Resume Next
  Dim bf, bline
  Set bf = fso.OpenTextFile(backendFile, 1)
  Do Until bf.AtEndOfStream
    bline = Trim(bf.ReadLine)
    If LCase(Left(bline, 13)) = "backend_type=" Then backendType = Mid(bline, 14)
    If LCase(Left(bline, 12)) = "backend_url=" Then backendUrl = Mid(bline, 13)
  Loop
  bf.Close
  On Error GoTo 0
End If
wshShell.Environment("Process")("BACKEND_TYPE") = backendType
wshShell.Environment("Process")("BACKEND_URL") = backendUrl
wshShell.Environment("Process")("OLLAMA_URL") = backendUrl

' Start Ollama if not running (only needed for the ollama backend)
Dim startOllama
startOllama = (LCase(backendType) = "ollama")
Dim svcRunning
svcRunning = False
Dim wmi, col
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set col = wmi.ExecQuery("SELECT * FROM Win32_Process WHERE Name='ollama.exe'")
If col.Count > 0 Then svcRunning = True

If startOllama And Not svcRunning Then
  If fso.FileExists(ollamaDir & "\ollama.exe") Then
    wshShell.Run """" & ollamaDir & "\ollama.exe"" serve", 0, False
    WScript.Sleep 4000
  End If
End If

' Start web UI if port closed
Dim portOpen
portOpen = False
Dim http
Set http = CreateObject("MSXML2.XMLHTTP")
http.setTimeouts 2000, 2000, 2000, 2000
On Error Resume Next
http.Open "GET", "http://127.0.0.1:8080/", False
http.Send
If Err.Number = 0 And http.Status = 200 Then portOpen = True
On Error GoTo 0

If Not portOpen Then
  Dim nodeExe
  nodeExe = "node"
  If fso.FileExists(base & "\runtime\node\node.exe") Then
    nodeExe = """" & base & "\runtime\node\node.exe"""
  ElseIf fso.FileExists("C:\Program Files\nodejs\node.exe") Then
    nodeExe = """C:\Program Files\nodejs\node.exe"""
  ' Bind to the LAN only when the installer recorded LAN access; default is localhost.
  If fso.FileExists(base & "\lan-access.txt") Then
    wshShell.Environment("Process")("HOST") = "0.0.0.0"
  Else
    wshShell.Environment("Process")("HOST") = "127.0.0.1"
  End If
  wshShell.Run "cmd /c cd /d """ & base & """ && " & nodeExe & " server.js", 0, False
  WScript.Sleep 4000
End If

' Launch app window - try Edge, Chrome, then default browser
Dim browserCmd
browserCmd = ""
If fso.FileExists(wshShell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe") Then
  browserCmd = """" & wshShell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe"" --app=http://127.0.0.1:8080 --window-size=1200,800"
ElseIf fso.FileExists(wshShell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe") Then
  browserCmd = """" & wshShell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe"" --app=http://127.0.0.1:8080 --window-size=1200,800"
ElseIf fso.FileExists(wshShell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe") Then
  browserCmd = """" & wshShell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe"" --app=http://127.0.0.1:8080 --window-size=1200,800"
ElseIf fso.FileExists(wshShell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Google\Chrome\Application\chrome.exe") Then
  browserCmd = """" & wshShell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Google\Chrome\Application\chrome.exe"" --app=http://127.0.0.1:8080 --window-size=1200,800"
End If

If browserCmd <> "" Then
  wshShell.Run browserCmd, 1, False
Else
  ' Fall back to default browser
  wshShell.Run "http://127.0.0.1:8080", 1, False
End If

On Error GoTo 0