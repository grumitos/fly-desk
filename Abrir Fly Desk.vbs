Set shell = CreateObject("WScript.Shell")
scriptPath = Replace(WScript.ScriptFullName, "Abrir Fly Desk.vbs", "tools\launch-fly-desk.cmd")
command = "cmd.exe /c """ & scriptPath & """"
shell.Run command, 0, False
