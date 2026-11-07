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

' Remove shortcuts
Dim removed
removed = ""
If fso.FileExists(sh.SpecialFolders("Desktop") & "\LocalAI.lnk") Then
  fso.DeleteFile sh.SpecialFolders("Desktop") & "\LocalAI.lnk", True
  removed = removed & "Desktop shortcut removed." & vbCrLf
End If
If fso.FileExists(sh.SpecialFolders("Startup") & "\LocalAI.lnk") Then
  fso.DeleteFile sh.SpecialFolders("Startup") & "\LocalAI.lnk", True
  removed = removed & "Startup shortcut removed." & vbCrLf
End If
If removed = "" Then removed = "No shortcuts found." & vbCrLf

' Remove app files if requested
If confirm = vbYes Then
  ' Stop running server? best-effort: kill node processes running server.js (skip; user can stop manually)
  MsgBox "Please ensure LocalAI is not running before files are deleted.", vbExclamation, "LocalAI Uninstaller"
  On Error Resume Next
  fso.DeleteFolder base, True
  If Err.Number <> 0 Then
    MsgBox "Could not fully remove folder: " & Err.Description & vbCrLf & _
           "Some files may be in use. Delete manually: " & base, vbExclamation, "LocalAI Uninstaller"
  Else
    removed = removed & "Application folder removed." & vbCrLf
  End If
  On Error GoTo 0
End If

MsgBox "Uninstall complete." & vbCrLf & vbCrLf & removed, vbInformation, "LocalAI Uninstaller"