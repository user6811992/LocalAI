' LocalAI uninstaller (Windows Script Host / standard Windows shell)
Option Explicit
On Error Resume Next

Dim sh, fso, base
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)
If base = "" Then base = sh.CurrentDirectory

Dim confirm
confirm = MsgBox("Uninstall LocalAI from:" & vbCrLf & base & vbCrLf & vbCrLf & _
                 "This removes shortcuts. Remove the application files too?", _
                 vbYesNoCancel + vbQuestion, "LocalAI Uninstaller")
If confirm = vbCancel Then WScript.Quit 0

' ---------- stop running server ----------
Dim wmiProc, colProc, pNode
Set wmiProc = GetObject("winmgmts:\\.\root\cimv2")
Set colProc = wmiProc.ExecQuery("SELECT * FROM Win32_Process WHERE Name='node.exe'")
For Each pNode In colProc
  If InStr(1, pNode.CommandLine, "server.js", vbTextCompare) > 0 Then
    pNode.Terminate
    WScript.Sleep 2000
  End If
Next
' (taskkill with a WINDOWTITLE filter never matches node.exe windows; the WMI
'  termination above is sufficient.)

' ---------- remove the firewall rule added for LAN access ----------
On Error Resume Next
' install.vbs / aegisai.iss create the rule as "AegisAI"; older builds used "LocalAI".
sh.Run "netsh advfirewall firewall delete rule name=""AegisAI""", 0, True
sh.Run "netsh advfirewall firewall delete rule name=""LocalAI""", 0, True
On Error GoTo 0

' ---------- export user data before removal ----------
Dim backupDir, udFiles, udf
backupDir = sh.SpecialFolders("Desktop") & "\AegisAI-backup-" & Year(Now) & Month(Now) & Day(Now)
If confirm = vbYes Then
  If Not fso.FolderExists(backupDir) Then fso.CreateFolder backupDir
  udFiles = Array("search-config.json", "memory.json", "skills.json", "chats.json", "rag-store.json", "auth.json", "settings.json", "setup-done.flag", "aegisai.db")
  Dim exported
  exported = ""
  For Each udf In udFiles
    If fso.FileExists(base & "\" & udf) Then
      fso.CopyFile base & "\" & udf, backupDir & "\" & udf, True
      exported = exported & udf & vbCrLf
    End If
  Next
  If fso.FolderExists(base & "\workspace") Then
    fso.CopyFolder base & "\workspace", backupDir & "\workspace", True
    exported = exported & "workspace/" & vbCrLf
  End If
  If exported <> "" Then
    MsgBox "User data exported to:" & vbCrLf & backupDir & vbCrLf & vbCrLf & exported, vbInformation, "LocalAI Uninstaller"
  End If
End If

' Remove shortcuts
Dim removed
removed = ""
If fso.FileExists(sh.SpecialFolders("Desktop") & "\AegisAI.lnk") Then
  fso.DeleteFile sh.SpecialFolders("Desktop") & "\AegisAI.lnk", True
  removed = removed & "Desktop shortcut removed." & vbCrLf
End If
If fso.FileExists(sh.SpecialFolders("Startup") & "\AegisAI.lnk") Then
  fso.DeleteFile sh.SpecialFolders("Startup") & "\AegisAI.lnk", True
  removed = removed & "Startup shortcut removed." & vbCrLf
End If
If removed = "" Then removed = "No shortcuts found." & vbCrLf

' Validate this is actually an AegisAI folder before deleting
Dim isAegisAI
isAegisAI = False
If fso.FileExists(base & "\server.js") And fso.FileExists(base & "\package.json") Then
  Dim pkgContent
  pkgContent = fso.OpenTextFile(base & "\package.json", 1).ReadAll()
  If InStr(1, pkgContent, "aegisai", vbTextCompare) > 0 Then
    isAegisAI = True
  End If
End If

' Remove app files if requested
If confirm = vbYes Then
  If Not isAegisAI Then
    MsgBox "This does not appear to be an AegisAI installation folder. Aborting file removal." & vbCrLf & base, vbExclamation, "LocalAI Uninstaller"
  Else
    On Error Resume Next
  ' Remove node_modules
  If fso.FolderExists(base & "\node_modules") Then
    fso.DeleteFolder base & "\node_modules", True
    If Err.Number = 0 Then removed = removed & "node_modules removed." & vbCrLf
  End If
  ' Remove .update-backup
  If fso.FolderExists(base & "\.update-backup") Then
    fso.DeleteFolder base & "\.update-backup", True
    If Err.Number = 0 Then removed = removed & ".update-backup removed." & vbCrLf
  End If
  ' Remove data cache
  If fso.FolderExists(base & "\data") Then
    fso.DeleteFolder base & "\data", True
    If Err.Number = 0 Then removed = removed & "data cache removed." & vbCrLf
  End If
  ' Remove app folder
  fso.DeleteFolder base, True
  If Err.Number <> 0 Then
    MsgBox "Could not fully remove folder: " & Err.Description & vbCrLf & _
           "Some files may be in use. Delete manually: " & base, vbExclamation, "LocalAI Uninstaller"
  Else
    removed = removed & "Application folder removed." & vbCrLf
  End If
  On Error GoTo 0
  End If
End If

MsgBox "Uninstall complete." & vbCrLf & vbCrLf & removed, vbInformation, "LocalAI Uninstaller"