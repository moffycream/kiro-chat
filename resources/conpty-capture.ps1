<#
  Runs a console program inside a Windows pseudo-console (ConPTY) that nobody
  sees, types what it is told to, and prints everything the program drew.

  Why this exists: Qoder CLI shows account usage only on its interactive
  `/usage` screen, and that screen draws nothing without a real terminal —
  with plain pipes the program prints no output at all (measured against
  qodercli 1.1.91). Node has no pseudo-terminal of its own without a native
  module, and Windows has had ConPTY since 10 1809, so the extension borrows it
  through PowerShell instead of shipping a binary.

  Steps are joined with "~~" into one argument, because `-File` hands every
  argument over as a single string. Each is "<head>|<text to send>":
    1500|/usage      wait 1500 ms, then type "/usage"
    wait:Type/trust| wait until either word is drawn after the last input
    if:trust|\r      press Enter only if "trust" was drawn at all
    done:Duration    wait for the word, then stop early
  "\r" in the text is Enter and "\e" is Escape. Waiting stops at -TotalMs, and
  the program is killed then whatever state it is in.
  Output is the raw VT stream, base64-encoded UTF-8, so nothing between here
  and Node can mangle it.
#>
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$Arguments = "",
  [string]$Cwd = (Get-Location).Path,
  [string]$Steps = "",
  [int]$TotalMs = 15000,
  [int]$Cols = 120,
  [int]$Rows = 40
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class KiroChatConPty {
  [StructLayout(LayoutKind.Sequential)] struct COORD { public short X; public short Y; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
    public int dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern int CreatePseudoConsole(COORD size, SafeFileHandle hInput, SafeFileHandle hOutput, uint dwFlags, out IntPtr phPC);
  [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr hPC);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CreatePipe(out SafeFileHandle hReadPipe, out SafeFileHandle hWritePipe, IntPtr lpPipeAttributes, int nSize);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = (IntPtr)0x00020016;

  public static string Run(string commandLine, string cwd, string[] steps, int totalMs, short cols, short rows) {
    SafeFileHandle inRead, inWrite, outRead, outWrite;
    if (!CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0)) throw new Exception("CreatePipe in failed");
    if (!CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0)) throw new Exception("CreatePipe out failed");

    IntPtr hPC;
    int hr = CreatePseudoConsole(new COORD { X = cols, Y = rows }, inRead, outWrite, 0, out hPC);
    if (hr != 0) throw new Exception("CreatePseudoConsole failed: " + hr);

    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    IntPtr attrs = Marshal.AllocHGlobal(size);
    if (!InitializeProcThreadAttributeList(attrs, 1, 0, ref size)) throw new Exception("InitializeProcThreadAttributeList failed");
    if (!UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hPC, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
      throw new Exception("UpdateProcThreadAttribute failed");

    var si = new STARTUPINFOEX();
    si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
    si.lpAttributeList = attrs;
    // Without this the child takes PowerShell's own standard handles, which
    // are pipes to Node, and writes past the pseudo-console entirely. Empty
    // handles plus the flag make the console subsystem use the pseudo-console.
    si.StartupInfo.dwFlags = 0x00000100; // STARTF_USESTDHANDLES
    PROCESS_INFORMATION pi;
    if (!CreateProcess(null, commandLine, IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, cwd, ref si, out pi))
      throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());

    // The pseudo-console owns these ends now.
    inRead.Dispose();
    outWrite.Dispose();

    var output = new MemoryStream();
    var reader = new Thread(() => {
      var stream = new FileStream(outRead, FileAccess.Read);
      var buffer = new byte[8192];
      try {
        int n;
        while ((n = stream.Read(buffer, 0, buffer.Length)) > 0) {
          lock (output) output.Write(buffer, 0, n);
        }
      } catch { }
    });
    reader.IsBackground = true;
    reader.Start();

    var input = new FileStream(inWrite, FileAccess.Write);
    var started = DateTime.UtcNow;
    // Where the output stood when input was last sent: "wait" and "done" look
    // only at what the program drew in answer to it.
    int sinceSend = 0;
    Func<int> length = () => { lock (output) return (int)output.Length; };
    Func<int, string> text = (from) => {
      lock (output) {
        var all = output.ToArray();
        return Encoding.UTF8.GetString(all, from, all.Length - from);
      }
    };
    Func<int> remaining = () => totalMs - (int)(DateTime.UtcNow - started).TotalMilliseconds;
    // Any of the tokens, separated by "/", turning up after `from`.
    Func<string, int, bool> waitFor = (tokens, from) => {
      var any = tokens.Split('/');
      while (remaining() > 0) {
        var seen = text(from);
        foreach (var token in any) if (seen.Contains(token)) return true;
        Thread.Sleep(100);
      }
      return false;
    };
    bool finished = false;

    foreach (var step in steps) {
      if (remaining() <= 0) break;
      int bar = step.IndexOf('|');
      string head = bar >= 0 ? step.Substring(0, bar) : step;
      string send = (bar >= 0 ? step.Substring(bar + 1) : "").Replace("\\r", "\r").Replace("\\e", "\u001b");

      if (head.StartsWith("wait:")) {
        // Until the program shows it is ready for the next input.
        if (!waitFor(head.Substring(5), sinceSend)) break;
      } else if (head.StartsWith("if:")) {
        // Only when something was drawn at all, e.g. a prompt that a folder
        // seen before does not get. Nothing is sent otherwise.
        if (!text(0).Contains(head.Substring(3))) continue;
      } else if (head.StartsWith("done:")) {
        // The screen wanted has been drawn: let it finish, then stop early.
        if (waitFor(head.Substring(5), sinceSend)) Thread.Sleep(400);
        finished = true;
        break;
      } else if (head.Length > 0) {
        Thread.Sleep(int.Parse(head));
      }

      if (send.Length == 0) continue;
      sinceSend = length();
      var bytes = Encoding.UTF8.GetBytes(send);
      try { input.Write(bytes, 0, bytes.Length); input.Flush(); } catch { break; }
    }
    if (!finished) {
      int left = remaining();
      if (left > 0 && steps.Length == 0) Thread.Sleep(left);
    }

    TerminateProcess(pi.hProcess, 0);
    ClosePseudoConsole(hPC);
    reader.Join(2000);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    DeleteProcThreadAttributeList(attrs);
    Marshal.FreeHGlobal(attrs);
    try { input.Dispose(); } catch { }

    lock (output) return Convert.ToBase64String(output.ToArray());
  }
}
"@

$commandLine = if ($Arguments) { "`"$Exe`" $Arguments" } else { "`"$Exe`"" }
# An `if` that yields @() yields $null in PowerShell, so build the list apart.
[string[]]$stepList = @()
if ($Steps) { $stepList = $Steps -split "~~" }
[Console]::Out.Write([KiroChatConPty]::Run($commandLine, $Cwd, [string[]]$stepList, $TotalMs, $Cols, $Rows))
