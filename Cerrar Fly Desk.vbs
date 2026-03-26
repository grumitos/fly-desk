Set shell = CreateObject("WScript.Shell")
scriptPath = Replace(WScript.ScriptFullName, "Cerrar Fly Desk.vbs", "tools\stop-fly-desk.cmd")
command = "cmd.exe /c """ & scriptPath & """"
shell.Run command, 0, False
