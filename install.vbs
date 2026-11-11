' LocalAI installer (Windows Script Host / standard Windows shell)
' Novice-friendly: double-click to install.
' Asks install location, pulls components/models in proper order, desktop shortcut selection.
Option Explicit
On Error Resume Next

Dim sh, fso
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' ---------- recommended models in pull order (with approximate sizes) ----------
Dim modelList, modelSize
modelList = Array("llama3.2:3b", "llama3.2:1b", "qwen2.5:14b", "qwen2.5-coder:14b", _
                  "qwen2.5-coder:7b", "mistral:7b", "phi3:mini", "gemma2:9b", _
                  "deepseek-coder:6.7b", "deepseek-coder-v2:16b", "deepseek-r1:14b", _
                  "nomic-embed-text", "moondream")
modelSize = Array("~2.0 GB", "~1.3 GB", "~9.0 GB", "~9.0 GB", _
                  "~4.7 GB", "~4.1 GB", "~2.3 GB", "~5.4 GB", _
                  "~3.8 GB", "~8.9 GB", "~9.0 GB", _
                  "~0.3 GB", "~1.7 GB")

' Resolve ollama binary path
Function ResolveOllama()
  Dim cand
  cand = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Ollama\ollama.exe"
  If fso.FileExists(cand) Then ResolveOllama = cand : Exit Function
  If fso.FileExists("C:\Program Files\Ollama\ollama.exe") Then ResolveOllama = "C:\Program Files\Ollama\ollama.exe" : Exit Function
  If ExeExists("ollama") Then ResolveOllama = "ollama" : Exit Function
  ResolveOllama = "ollama"
End Function

' ---------- helpers ----------
Function ExeExists(name)
  Dim exec, out
  On Error Resume Next
  Set exec = sh.Exec("cmd /c where " & name & " 2>nul")
  out = exec.StdOut.ReadAll()
  ExeExists = (Len(Trim(out)) > 0)
  On Error GoTo 0
End Function

Sub CreateShortcut(appBase, lnkPath, desc)
  Dim sc, iconPath
  iconPath = appBase & "\public\icon.ico"
  If Not fso.FileExists(iconPath) Then iconPath = "shell32.dll,13"
  Set sc = sh.CreateShortcut(lnkPath)
  sc.TargetPath = "wscript.exe"
  sc.Arguments = """" & appBase & "\launcher.vbs"""
  sc.WorkingDirectory = appBase
  sc.Description = desc
  sc.IconLocation = iconPath
  sc.Save
End Sub

Function IIf(cond, a, b)
  If cond Then IIf = a Else IIf = b
End Function

Sub LogMsg(logPath, msg)
  On Error Resume Next
  Dim ts
  Set ts = fso.OpenTextFile(logPath, 8, True)
  ts.WriteLine Now() & " - " & msg
  ts.Close
  On Error GoTo 0
End Sub

Function BrowseForFolder(prompt, defaultPath)
  Dim shellApp, folder
  Set shellApp = CreateObject("Shell.Application")
  Set folder = shellApp.BrowseForFolder(0, prompt, 0, defaultPath)
  If folder Is Nothing Then
    BrowseForFolder = ""
  Else
    BrowseForFolder = folder.Self.Path
  End If
End Function

' ---------- start ----------
Dim srcBase
srcBase = fso.GetParentFolderName(WScript.ScriptFullName)
If srcBase = "" Then srcBase = sh.CurrentDirectory

' ---------- scan drives for existing tools/models ----------
Dim scanReport
scanReport = "Drive scan results:" & vbCrLf & vbCrLf

' Helper: check a path
Function CheckPath(label, p)
  If fso.FolderExists(p) Or fso.FileExists(p) Then
    CheckPath = "  [FOUND] " & label & ": " & p
  Else
    CheckPath = "  [missing] " & label
  End If
End Function

' Common tool locations
scanReport = scanReport & "Tools:" & vbCrLf
scanReport = scanReport & CheckPath("Ollama", sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Ollama\ollama.exe") & vbCrLf
scanReport = scanReport & CheckPath("Node.js", "C:\Program Files\nodejs\node.exe") & vbCrLf
scanReport = scanReport & CheckPath("Ghidra (C:)", "C:\Ghidra") & vbCrLf
scanReport = scanReport & CheckPath("jadx (C:)", "C:\jadx") & vbCrLf
scanReport = scanReport & CheckPath("Java (Adoptium)", "C:\Program Files\Eclipse Adoptium") & vbCrLf

' Scan other drives for Ghidra/jadx/Ollama folders
Dim drv, drvLetter
For Each drv In fso.Drives
  If drv.IsReady Then
    drvLetter = drv.DriveLetter & ":\"
    If UCase(drvLetter) <> "C:\" Then
      If fso.FolderExists(drvLetter & "Ghidra") Then scanReport = scanReport & "  [FOUND] Ghidra on " & drvLetter & vbCrLf
      If fso.FolderExists(drvLetter & "jadx") Then scanReport = scanReport & "  [FOUND] jadx on " & drvLetter & vbCrLf
      If fso.FolderExists(drvLetter & "Ollama") Then scanReport = scanReport & "  [FOUND] Ollama on " & drvLetter & vbCrLf
      If fso.FolderExists(drvLetter & "Tools") Then scanReport = scanReport & "  [FOUND] Tools folder on " & drvLetter & vbCrLf
    End If
  End If
Next

' Ollama models
Dim ollamaModelsPath
ollamaModelsPath = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.ollama\models"
scanReport = scanReport & vbCrLf & "Ollama models:" & vbCrLf
If fso.FolderExists(ollamaModelsPath) Then
  scanReport = scanReport & "  [FOUND] " & ollamaModelsPath & vbCrLf
Else
  scanReport = scanReport & "  [missing] " & ollamaModelsPath & vbCrLf
End If

' Show scan results
MsgBox scanReport, vbInformation, "Drive scan"

' Welcome
MsgBox "Welcome to the LocalAI installer." & vbCrLf & vbCrLf & _
       "This will install LocalAI, pull recommended AI models in order, " & _
       "and create a desktop shortcut." & vbCrLf & vbCrLf & _
       "Source folder:" & vbCrLf & srcBase, vbInformation, "AegisAI Installer"

' ---------- choose install location ----------
Dim destBase
destBase = BrowseForFolder("Select the folder where LocalAI should be installed " & _
                           "(a new 'LocalAI' subfolder will be used if you pick a drive).", 0)
If destBase = "" Then
  MsgBox "Installation cancelled.", vbInformation, "AegisAI Installer"
  WScript.Quit 0
End If
' If user picked a drive root or existing folder, append LocalAI unless server.js already there
If Not fso.FileExists(destBase & "\server.js") Then
  destBase = destBase & "\LocalAI"
End If

' Confirm
Dim confirm
confirm = MsgBox("Install to:" & vbCrLf & destBase & vbCrLf & vbCrLf & _
                 "Continue?", vbYesNo + vbQuestion, "Install location")
If confirm <> vbYes Then
  MsgBox "Installation cancelled.", vbInformation, "AegisAI Installer"
  WScript.Quit 0
End If

' Create destination if needed
If Not fso.FolderExists(destBase) Then
  fso.CreateFolder destBase
End If

Dim logPath
logPath = destBase & "\install.log"
LogMsg logPath, "=== LocalAI install started ==="
LogMsg logPath, "Source: " & srcBase
LogMsg logPath, "Destination: " & destBase

' ---------- update vs fresh install ----------
Dim updateOnly
updateOnly = False
If fso.FileExists(destBase & "\server.js") Then
  Dim updAns
  updAns = MsgBox("An existing LocalAI installation was found in:" & vbCrLf & destBase & vbCrLf & vbCrLf & _
                  "Update core application files only (keep models & shortcuts)?" & vbCrLf & _
                  "(Choose No for a full install.)", vbYesNoCancel + vbQuestion, "Update detected")
  If updAns = vbCancel Then
    MsgBox "Installation cancelled.", vbInformation, "AegisAI Installer"
    WScript.Quit 0
  End If
  updateOnly = (updAns = vbYes)
End If
If updateOnly Then LogMsg logPath, "Mode: UPDATE (core files only)."

' ---------- stop running server before update ----------
If updateOnly Then
  On Error Resume Next
  Dim wmiProc, colProc
  Set wmiProc = GetObject("winmgmts:\\.\root\cimv2")
  Set colProc = wmiProc.ExecQuery("SELECT * FROM Win32_Process WHERE Name='node.exe'")
  Dim pNode
  For Each pNode In colProc
    If InStr(1, pNode.CommandLine, "server.js", vbTextCompare) > 0 Then
      pNode.Terminate
      LogMsg logPath, "Terminated running server process (PID " & pNode.ProcessId & ")."
    End If
  Next
  ' Wait for process to exit
  WScript.Sleep 2000
  On Error GoTo 0
End If

' ---------- version check ----------
Dim srcVersion, dstVersion
srcVersion = ""
dstVersion = ""
If fso.FileExists(srcBase & "\package.json") Then
  Dim vFile
  Set vFile = fso.OpenTextFile(srcBase & "\package.json", 1)
  Dim vContent
  vContent = vFile.ReadAll
  vFile.Close
  ' Extract version (simple regex)
  Dim vMatch
  Set vMatch = New RegExp
  vMatch.Pattern = """version""\s*:\s*""([^""]+)"""
  Dim vMatches
  Set vMatches = vMatch.Execute(vContent)
  If vMatches.Count > 0 Then srcVersion = vMatches(0).SubMatches(0)
End If
If fso.FileExists(destBase & "\package.json") Then
  Set vFile = fso.OpenTextFile(destBase & "\package.json", 1)
  vContent = vFile.ReadAll
  vFile.Close
  Set vMatches = vMatch.Execute(vContent)
  If vMatches.Count > 0 Then dstVersion = vMatches(0).SubMatches(0)
End If
If updateOnly And srcVersion <> "" And dstVersion <> "" And srcVersion = dstVersion Then
  MsgBox "Already up to date (v" & srcVersion & "). No update needed.", vbInformation, "AegisAI Installer"
  WScript.Quit 0
End If
If srcVersion <> "" Then LogMsg logPath, "Source version: " & srcVersion
If dstVersion <> "" Then LogMsg logPath, "Dest version: " & dstVersion

' ---------- backup before update ----------
If updateOnly Then
  On Error Resume Next
  Dim backupDir
  backupDir = destBase & "\.update-backup"
  If fso.FolderExists(backupDir) Then fso.DeleteFolder backupDir, True
  fso.CreateFolder backupDir
  ' Back up user data
  Dim udFiles
  udFiles = Array("search-config.json", "memory.json", "skills.json", "chats.json", "rag-store.json", "auth.json")
  Dim udf
  For Each udf In udFiles
    If fso.FileExists(destBase & "\" & udf) Then
      fso.CopyFile destBase & "\" & udf, backupDir & "\" & udf, True
    End If
  Next
  If fso.FolderExists(destBase & "\workspace") Then
    fso.CopyFolder destBase & "\workspace", backupDir & "\workspace", True
  End If
  LogMsg logPath, "Backup created in " & backupDir
  On Error GoTo 0
End If

' ---------- copy app files if destination differs from source ----------
If LCase(destBase) <> LCase(srcBase) Or updateOnly Then
  MsgBox "Copying application files to:" & vbCrLf & destBase & vbCrLf & vbCrLf & _
         "Please wait...", vbInformation, "AegisAI Installer"
  On Error Resume Next
  ' Copy individual items to avoid overwriting issues
  Dim item
  For Each item In fso.GetFolder(srcBase).Files
    fso.CopyFile item.Path, destBase & "\" & item.Name, True
  Next
  Dim subFolder
  For Each subFolder In fso.GetFolder(srcBase).SubFolders
    If LCase(subFolder.Name) <> "node_modules" Then
      fso.CopyFolder subFolder.Path, destBase & "\" & subFolder.Name, True
    End If
  Next
  If Err.Number <> 0 Then
    MsgBox "Warning while copying files: " & Err.Description, vbExclamation, "AegisAI Installer"
    LogMsg logPath, "Copy warning: " & Err.Description
  Else
    LogMsg logPath, "Files copied successfully."
  End If
  On Error GoTo 0
End If

' ---------- npm install ----------
If fso.FileExists(destBase & "\package.json") Then
  MsgBox "Installing npm dependencies..." & vbCrLf & "This may take a moment.", vbInformation, "AegisAI Installer"
  On Error Resume Next
  Dim npmRc
  npmRc = sh.Run("cmd /c cd /d """ & destBase & """ && npm install", 1, True)
  If Err.Number <> 0 Or npmRc <> 0 Then
    MsgBox "npm install may have failed (code " & npmRc & ")." & vbCrLf & _
           "Run manually: cd """ & destBase & """ && npm install", vbExclamation, "AegisAI Installer"
    LogMsg logPath, "npm install failed (rc=" & npmRc & ")."
  Else
    LogMsg logPath, "npm install completed."
  End If
  On Error GoTo 0
End If

' ---------- post-copy verification ----------
Dim verifyFiles
verifyFiles = Array("server.js", "package.json", "launcher.vbs", "public\index.html")
Dim vf, allPresent
allPresent = True
For Each vf In verifyFiles
  If Not fso.FileExists(destBase & "\" & vf) Then
    allPresent = False
    LogMsg logPath, "MISSING after copy: " & vf
  End If
Next
If Not allPresent Then
  MsgBox "Warning: Some files are missing after copy." & vbCrLf & _
         "Check " & logPath & " for details.", vbExclamation, "AegisAI Installer"
Else
  LogMsg logPath, "Verification passed: all key files present."
End If

' ---------- prerequisites ----------
Dim nodeOk, ollamaOk
nodeOk = ExeExists("node")
ollamaOk = ExeExists("ollama")
If Not ollamaOk Then
  If fso.FileExists(sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Ollama\ollama.exe") Then ollamaOk = True
End If

Dim prereqMsg
prereqMsg = "Prerequisites:" & vbCrLf & _
            "  Node.js: " & IIf(nodeOk, "found", "MISSING") & vbCrLf & _
            "  Ollama: " & IIf(ollamaOk, "found", "MISSING")
If Not nodeOk Or Not ollamaOk Then
  prereqMsg = prereqMsg & vbCrLf & vbCrLf & "Install missing prerequisites first:" & vbCrLf & _
              "  Node.js: https://nodejs.org" & vbCrLf & _
              "  Ollama:  https://ollama.com/download"
  MsgBox prereqMsg, vbExclamation, "AegisAI Installer"
  ' Continue; user may install later
End If

' ---------- pull models in proper order ----------
Dim pullModels
' Build model list with sizes for the prompt
Dim modelPrompt, mi
modelPrompt = "Pull all recommended AI models now?" & vbCrLf & vbCrLf & _
              "Approximate download sizes:" & vbCrLf
For mi = 0 To UBound(modelList)
  modelPrompt = modelPrompt & "  " & (mi + 1) & ". " & modelList(mi) & "  (" & modelSize(mi) & ")" & vbCrLf
Next
modelPrompt = modelPrompt & vbCrLf & "Total: ~59 GB. Models are pulled in the recommended order." & vbCrLf & _
              "This may take a while." & vbCrLf & vbCrLf & "Pull now?"

pullModels = (MsgBox(modelPrompt, vbYesNo + vbQuestion, "Model pull") = vbYes)

If updateOnly Then pullModels = False
If pullModels Then
  If Not ollamaOk Then
    MsgBox "Ollama is not installed. Skipping model pull." & vbCrLf & _
           "Install Ollama from https://ollama.com/download then re-run.", vbExclamation, "AegisAI Installer"
  Else
    ' Make sure the Ollama server is running before pulling.
    Dim ollamaRunning
    ollamaRunning = False
    Dim wmiO, colO
    Set wmiO = GetObject("winmgmts:\\.\root\cimv2")
    Set colO = wmiO.ExecQuery("SELECT * FROM Win32_Process WHERE Name='ollama.exe'")
    If colO.Count > 0 Then ollamaRunning = True
    If Not ollamaRunning Then
      sh.Run """" & ResolveOllama() & """ serve", 0, False
      WScript.Sleep 4000
    End If
    Dim i, m, rc, failedModels
    failedModels = ""
    For i = 0 To UBound(modelList)
      m = modelList(i)
      MsgBox "Pulling model " & (i + 1) & " of " & (UBound(modelList) + 1) & ":" & vbCrLf & m & "  (" & modelSize(i) & ")" & vbCrLf & vbCrLf & _
             "Please wait. This may take several minutes.", vbInformation, "Pulling models"
      On Error Resume Next
      rc = sh.Run("cmd /c """ & ResolveOllama() & """ pull " & m, 1, True)
      If Err.Number <> 0 Then
        MsgBox "Error pulling " & m & ": " & Err.Description, vbExclamation, "AegisAI Installer"
        failedModels = failedModels & m & vbCrLf
      ElseIf rc <> 0 Then
        MsgBox "ollama pull " & m & " returned code " & rc & "." & vbCrLf & _
               "Continuing with next model.", vbExclamation, "AegisAI Installer"
        failedModels = failedModels & m & vbCrLf
      End If
      On Error GoTo 0
    Next
    If failedModels <> "" Then
      MsgBox "Some models failed to pull:" & vbCrLf & failedModels & vbCrLf & _
             "Check your network connection and re-run the installer, or pull manually:" & vbCrLf & _
             "ollama pull <model>", vbExclamation, "AegisAI Installer"
    Else
      MsgBox "All models pulled successfully.", vbInformation, "AegisAI Installer"
    End If
    LogMsg logPath, "Model pull completed. Failed: " & failedModels
  End If
End If
If Not pullModels Then LogMsg logPath, "Model pull skipped."

' ---------- desktop shortcut selection ----------
Dim createDesktop
If updateOnly Then
  createDesktop = True
Else
  createDesktop = (MsgBox("Create a desktop shortcut for LocalAI?", vbYesNo + vbQuestion, "Desktop shortcut") = vbYes)
End If

If createDesktop Then
  On Error Resume Next
  CreateShortcut destBase, sh.SpecialFolders("Desktop") & "\AegisAI.lnk", "LocalAI"
  If Err.Number <> 0 Then
    MsgBox "Could not create desktop shortcut: " & Err.Description, vbExclamation, "AegisAI Installer"
    LogMsg logPath, "Desktop shortcut failed: " & Err.Description
  Else
    MsgBox "Desktop shortcut created.", vbInformation, "AegisAI Installer"
    LogMsg logPath, "Desktop shortcut created."
  End If
  On Error GoTo 0
End If
If Not createDesktop Then LogMsg logPath, "Desktop shortcut skipped."

' ---------- auto-start at login ----------
Dim autoStart
If updateOnly Then
  autoStart = False
Else
  autoStart = (MsgBox("Start LocalAI automatically when Windows starts?", vbYesNo + vbQuestion, "Auto-start") = vbYes)
End If
If autoStart Then
  On Error Resume Next
  CreateShortcut destBase, sh.SpecialFolders("Startup") & "\AegisAI.lnk", "AegisAI (auto-start)"
  If Err.Number <> 0 Then
    MsgBox "Could not create startup shortcut: " & Err.Description, vbExclamation, "AegisAI Installer"
    LogMsg logPath, "Startup shortcut failed: " & Err.Description
  Else
    MsgBox "LocalAI will start automatically at login.", vbInformation, "AegisAI Installer"
    LogMsg logPath, "Startup shortcut created."
  End If
  On Error GoTo 0
End If
If Not autoStart Then LogMsg logPath, "Auto-start skipped."

' ---------- firewall rule for LAN access ----------
Dim addFirewall
If updateOnly Then
  addFirewall = False
Else
  addFirewall = (MsgBox("Allow other devices on your network to access LocalAI?" & vbCrLf & _
                        "(Adds a Windows Firewall rule for port 8080.)", vbYesNo + vbQuestion, "LAN access") = vbYes)
End If
If addFirewall Then
  On Error Resume Next
  Dim fwRc
  ' LAN mode: the launcher reads this marker and binds the server to 0.0.0.0.
  Dim lanFlag
  Set lanFlag = fso.CreateTextFile(destBase & "\lan-access.txt", True)
  lanFlag.WriteLine "LAN access enabled by installer. Delete this file to return to localhost-only."
  lanFlag.Close
  fwRc = sh.Run("netsh advfirewall firewall add rule name=""LocalAI"" dir=in action=allow protocol=tcp localport=8080", 0, True)
  If Err.Number <> 0 Or fwRc <> 0 Then
    MsgBox "Could not add firewall rule (may need Administrator)." & vbCrLf & _
           "Run this manually as Administrator:" & vbCrLf & _
           "netsh advfirewall firewall add rule name=LocalAI dir=in action=allow protocol=tcp localport=8080", _
           vbExclamation, "AegisAI Installer"
    LogMsg logPath, "Firewall rule failed (rc=" & fwRc & ")."
  Else
    MsgBox "Firewall rule added. Other devices can reach http://<your-pc-ip>:8080", vbInformation, "AegisAI Installer"
    LogMsg logPath, "Firewall rule added."
  End If
  On Error GoTo 0
End If
If Not addFirewall Then LogMsg logPath, "Firewall rule skipped."

' ---------- launch now ----------
Dim launchNow
launchNow = (MsgBox("Launch LocalAI now?", vbYesNo + vbQuestion, "Launch") = vbYes)
If launchNow Then
  On Error Resume Next
  sh.Run "wscript.exe """ & destBase & "\launcher.vbs""", 1, False
  If Err.Number <> 0 Then
    MsgBox "Could not launch: " & Err.Description, vbExclamation, "AegisAI Installer"
  End If
  On Error GoTo 0
End If

If updateOnly Then
  MsgBox "Update complete." & vbCrLf & vbCrLf & _
         "Core application files updated in:" & vbCrLf & destBase & vbCrLf & vbCrLf & _
         "Models and shortcuts preserved." & vbCrLf & _
         "You can run LocalAI anytime from the desktop shortcut " & _
         "(or by double-clicking launcher.vbs).", vbInformation, "AegisAI Installer"
Else
  MsgBox "Installation complete." & vbCrLf & vbCrLf & _
         "Installed to:" & vbCrLf & destBase & vbCrLf & vbCrLf & _
         "You can run LocalAI anytime from the desktop shortcut " & _
         "(or by double-clicking launcher.vbs).", vbInformation, "AegisAI Installer"
End If

LogMsg logPath, "=== Install complete ==="
