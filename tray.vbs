' LocalAI system tray launcher (Windows Script Host)
' Double-click to start the tray icon (uses PowerShell for the NotifyIcon).
' Keeps the user-facing entry point as a .vbs (no console window).
Option Explicit
On Error Resume Next
Dim sh, fso, base
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
If base = "" Then base = sh.CurrentDirectory
If fso.FileExists(base & "\tray.ps1") Then
  sh.Run "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & base & "\tray.ps1""", 0, False
Else
  MsgBox "tray.ps1 not found in:" & vbCrLf & base, vbExclamation, "AegisAI Tray"
End If