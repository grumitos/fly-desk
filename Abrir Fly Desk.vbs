Set shell = CreateObject("WScript.Shell")
projectRoot = Replace(WScript.ScriptFullName, "Abrir Fly Desk.vbs", "")
scriptPath = projectRoot & "tools\start-fly-desk.ps1"
powerShellPath = "C:\Program Files\PowerShell\7\pwsh.exe"

If Not CreateObject("Scripting.FileSystemObject").FileExists(powerShellPath) Then
  powerShellPath = "powershell.exe"
End If

command = """" & powerShellPath & """ -NoProfile -ExecutionPolicy Bypass -File """ & scriptPath & """"
shell.Run command, 0, True
