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
If wshShell.Environment("Process")("REA_JADX_MCP_JAR") = "" Then wshShell.Environment("Process")("REA_JADX_MCP_JAR") = "C:\Tools\jadx-mcp\jadx-headless-mcp-0.7.1-all.jar"
' Build PATH without empty entries (only add dirs that are actually set).
Dim pathExtra
pathExtra = "C:\jadx\bin;"
If wshShell.Environment("Process")("GHIDRA_INSTALL_DIR") <> "" Then pathExtra = pathExtra & wshShell.Environment("Process")("GHIDRA_INSTALL_DIR") & ";"
If wshShell.Environment("Process")("JAVA_HOME") <> "" Then pathExtra = pathExtra & wshShell.Environment("Process")("JAVA_HOME") & "\bin;"
pathExtra = pathExtra & ollamaDir & ";" & "C:\Program Files\nodejs;" & wshShell.ExpandEnvironmentStrings("%APPDATA%") & "\npm;"
wshShell.Environment("Process")("PATH") = pathExtra & wshShell.Environment("Process")("PATH")

' ---------- Backend selection (from backend.txt written by installer) ----------
Dim backendType, backendUrl, backendModel
backendType = "ollama"
backendUrl = "http://127.0.0.1:11434"
backendModel = ""
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
    If LCase(Left(bline, 14)) = "backend_model=" Then backendModel = Mid(bline, 15)
  Loop
  bf.Close
  On Error GoTo 0
End If
wshShell.Environment("Process")("BACKEND_TYPE") = backendType
wshShell.Environment("Process")("BACKEND_URL") = backendUrl
wshShell.Environment("Process")("OLLAMA_URL") = backendUrl
If backendModel <> "" Then wshShell.Environment("Process")("BACKEND_MODEL") = backendModel

' ---------- Auth token (from auth.json written by installer for LAN access) ----------
' Single source of truth: auth.json. We only read the token here to pass it
' via the URL so the web UI can auto-populate localStorage. We do NOT set
' LOCALAI_TOKEN, so the server reads auth.json directly (avoids mismatches).
Dim authToken
authToken = ""
Dim authFile
authFile = base & "\auth.json"
' Fallback: auth-token.txt (plain text, written by the installer)
Dim tokenTxtFile
tokenTxtFile = base & "\auth-token.txt"
If (authToken = "") And fso.FileExists(tokenTxtFile) Then
  On Error Resume Next
  Dim tf
  Set tf = fso.OpenTextFile(tokenTxtFile, 1)
  authToken = Trim(tf.ReadLine)
  tf.Close
  On Error GoTo 0
End If
If fso.FileExists(authFile) Then
  On Error Resume Next
  Dim af, content
  Set af = fso.OpenTextFile(authFile, 1)
  content = af.ReadAll
  af.Close
  ' Extract the value of the "token" field (JSON: { "token": "..." })
  Dim keyPos, colonPos, firstQuote, secondQuote
  keyPos = InStr(1, content, Chr(34) & "token" & Chr(34), vbTextCompare)
  If keyPos > 0 Then
    colonPos = InStr(keyPos, content, ":")
    If colonPos > 0 Then
      firstQuote = InStr(colonPos, content, Chr(34))
      If firstQuote > 0 Then
        secondQuote = InStr(firstQuote + 1, content, Chr(34))
        If secondQuote > firstQuote Then
          authToken = Mid(content, firstQuote + 1, secondQuote - firstQuote - 1)
        End If
      End If
    End If
  End If
  On Error GoTo 0
End If

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
    ' Wait up to 10s for Ollama to become ready (don't hang forever)
    Dim ollamaReady, ollamaWait
    ollamaReady = False
    For ollamaWait = 1 To 10
      WScript.Sleep 1000
      Dim http2
      Set http2 = CreateObject("MSXML2.XMLHTTP")
      On Error Resume Next
      http2.Open "GET", "http://127.0.0.1:11434/api/version", False
      http2.Send
      If Err.Number = 0 And http2.Status = 200 Then ollamaReady = True
      On Error GoTo 0
      Set http2 = Nothing
      If ollamaReady Then Exit For
    Next
  End If
End If

' ---------- Auto-start non-Ollama backends ----------
Dim backendRunning
backendRunning = False

If LCase(backendType) = "llamacpp" Then
  ' Discover llama-server binary
  Dim llamaDir
  llamaDir = ""
  If fso.FileExists("C:\Program Files\llama.cpp\llama-server.exe") Then llamaDir = "C:\Program Files\llama.cpp"
  If llamaDir = "" And fso.FileExists(wshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\llama.cpp\llama-server.exe") Then llamaDir = wshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\llama.cpp"
  If llamaDir = "" Then
    ' Try PATH
    Dim lexec, lout
    Set lexec = wshShell.Exec("cmd /c where llama-server 2>nul")
    lout = lexec.StdOut.ReadAll()
    If Len(Trim(lout)) > 0 Then llamaDir = fso.GetParentFolderName(Trim(Split(lout, vbCrLf)(0)))
  End If
  ' Check if backend port is already open
  Dim backendPort
  backendPort = "8081"
  Dim urlParts
  urlParts = Split(backendUrl, ":")
  If UBound(urlParts) >= 2 Then backendPort = urlParts(UBound(urlParts))
  backendPort = Replace(backendPort, "/", "")
  Dim bhttp
  Set bhttp = CreateObject("MSXML2.XMLHTTP")
  On Error Resume Next
  bhttp.Open "GET", backendUrl & "/health", False
  bhttp.Send
  If Err.Number = 0 And bhttp.Status = 200 Then backendRunning = True
  Err.Clear
  On Error GoTo 0
  Set bhttp = Nothing
  If Not backendRunning And llamaDir <> "" And backendModel <> "" Then
    If fso.FileExists(llamaDir & "\llama-server.exe") And fso.FileExists(backendModel) Then
      wshShell.Run """" & llamaDir & "\llama-server.exe"" -m """ & backendModel & """ --port " & backendPort, 0, False
      ' Wait up to 15s for llama-server to be ready
      Dim llamaReady, llamaWait
      llamaReady = False
      For llamaWait = 1 To 15
        WScript.Sleep 1000
        Set bhttp = CreateObject("MSXML2.XMLHTTP")
        On Error Resume Next
        bhttp.Open "GET", backendUrl & "/health", False
        bhttp.Send
        If Err.Number = 0 And bhttp.Status = 200 Then llamaReady = True
        Err.Clear
        On Error GoTo 0
        Set bhttp = Nothing
        If llamaReady Then Exit For
      Next
    End If
  End If
End If

If LCase(backendType) = "lmstudio" Then
  ' Try to start LM Studio server via lms CLI
  Dim lmsPath
  lmsPath = ""
  Set lexec = wshShell.Exec("cmd /c where lms 2>nul")
  lout = lexec.StdOut.ReadAll()
  If Len(Trim(lout)) > 0 Then lmsPath = Trim(Split(lout, vbCrLf)(0))
  ' Check if backend is already running
  Set bhttp = CreateObject("MSXML2.XMLHTTP")
  On Error Resume Next
  bhttp.Open "GET", backendUrl & "/v1/models", False
  bhttp.Send
  If Err.Number = 0 And bhttp.Status = 200 Then backendRunning = True
  Err.Clear
  On Error GoTo 0
  Set bhttp = Nothing
  If Not backendRunning And lmsPath <> "" Then
    wshShell.Run """" & lmsPath & """ server start", 0, False
    WScript.Sleep 5000
  End If
End If

' Start web UI if port closed (retry up to 3 times with timeout)
Dim portOpen
portOpen = False
Dim http, httpOk
httpOk = False
On Error Resume Next
' Try MSXML2.ServerXMLHTTP first (supports setTimeouts), fall back to XMLHTTP
Dim useServerXml
useServerXml = False
On Error Resume Next
Dim testHttp
Set testHttp = CreateObject("MSXML2.ServerXMLHTTP")
If Err.Number = 0 Then useServerXml = True
Set testHttp = Nothing
Err.Clear
On Error GoTo 0

Dim retryCount
For retryCount = 1 To 3
  On Error Resume Next
  If useServerXml Then
    Set http = CreateObject("MSXML2.ServerXMLHTTP")
    http.setTimeouts 5000, 5000, 5000, 5000
  Else
    Set http = CreateObject("MSXML2.XMLHTTP")
  End If
  http.Open "GET", "http://127.0.0.1:8080/", False
  http.Send
  If Err.Number = 0 And http.Status = 200 Then
    portOpen = True
    httpOk = True
  End If
  Err.Clear
  On Error GoTo 0
  Set http = Nothing
  If portOpen Then Exit For
  WScript.Sleep 1000
Next

' Ensure dependencies are installed
If Not fso.FolderExists(base & "\node_modules\@modelcontextprotocol\sdk") Then
  Dim npmExe
  npmExe = "npm"
  If fso.FileExists(base & "\runtime\node\npm.cmd") Then
    npmExe = """" & base & "\runtime\node\npm.cmd"""
  ElseIf fso.FileExists("C:\Program Files\nodejs\npm.cmd") Then
    npmExe = """C:\Program Files\nodejs\npm.cmd"""
  End If
  wshShell.Run "cmd /c cd /d """ & base & """ && " & npmExe & " install", 1, True
  WScript.Sleep 2000
  If Not fso.FolderExists(base & "\node_modules\@modelcontextprotocol\sdk") Then
    MsgBox "Dependencies could not be installed." & vbCrLf & vbCrLf & _
           "Please run manually:" & vbCrLf & _
           "cd """ & base & """" & vbCrLf & _
           "npm install" & vbCrLf & vbCrLf & _
           "Then re-run launcher.vbs.", vbExclamation, "AegisAI Launcher"
    WScript.Quit 1
  End If
End If

If Not portOpen Then
  Dim nodeExe
  nodeExe = "node"
  If fso.FileExists(base & "\runtime\node\node.exe") Then
    nodeExe = """" & base & "\runtime\node\node.exe"""
  ElseIf fso.FileExists("C:\Program Files\nodejs\node.exe") Then
    nodeExe = """C:\Program Files\nodejs\node.exe"""
  End If
  ' Bind to the LAN only when the installer recorded LAN access; default is localhost.
  If fso.FileExists(base & "\lan-access.txt") Then
    wshShell.Environment("Process")("HOST") = "0.0.0.0"
  Else
    wshShell.Environment("Process")("HOST") = "127.0.0.1"
  End If
  ' Start server with output redirected to a log file for diagnostics
  wshShell.Run "cmd /c cd /d """ & base & """ && " & nodeExe & " server.js > """ & base & "\server.log"" 2>&1", 0, False
  ' Wait up to 30s for the server to become ready
  Dim serverReady, serverWait
  serverReady = False
  For serverWait = 1 To 30
    WScript.Sleep 1000
    On Error Resume Next
    If useServerXml Then
      Set http = CreateObject("MSXML2.ServerXMLHTTP")
      http.setTimeouts 3000, 3000, 3000, 3000
    Else
      Set http = CreateObject("MSXML2.XMLHTTP")
    End If
    http.Open "GET", "http://127.0.0.1:8080/", False
    http.Send
    If Err.Number = 0 And http.Status = 200 Then serverReady = True
    Err.Clear
    On Error GoTo 0
    Set http = Nothing
    If serverReady Then Exit For
  Next
  If Not serverReady Then
    MsgBox "AegisAI server did not start within 30 seconds." & vbCrLf & vbCrLf & _
           "Check the log file for errors:" & vbCrLf & base & "\server.log" & vbCrLf & vbCrLf & _
           "Common causes: Node.js not found, missing dependencies (run npm install), or port 8080 in use.", _
           vbExclamation, "AegisAI Launcher"
  End If
End If

' Build the app URL, appending the auth token so the web UI auto-populates it.
Dim appUrl
appUrl = "http://127.0.0.1:8080"
If authToken <> "" Then appUrl = appUrl & "?token=" & authToken

' Launch app window - try Edge, Chrome, then default browser
Dim browserCmd
browserCmd = ""
If fso.FileExists(wshShell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe") Then
  browserCmd = """" & wshShell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe"" --app=" & appUrl & " --window-size=1200,800"
ElseIf fso.FileExists(wshShell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe") Then
  browserCmd = """" & wshShell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe"" --app=" & appUrl & " --window-size=1200,800"
ElseIf fso.FileExists(wshShell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe") Then
  browserCmd = """" & wshShell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe"" --app=" & appUrl & " --window-size=1200,800"
ElseIf fso.FileExists(wshShell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Google\Chrome\Application\chrome.exe") Then
  browserCmd = """" & wshShell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Google\Chrome\Application\chrome.exe"" --app=" & appUrl & " --window-size=1200,800"
End If

If browserCmd <> "" Then
  wshShell.Run browserCmd, 1, False
Else
  ' Fall back to default browser
  wshShell.Run appUrl, 1, False
End If

On Error GoTo 0