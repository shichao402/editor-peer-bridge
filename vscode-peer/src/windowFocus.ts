import { spawn } from 'child_process'
import * as vscode from 'vscode'

/**
 * Best-effort: raise this editor's OS window to the foreground.
 *
 * `vscode.window.showTextDocument({ preserveFocus: false })` only focuses the
 * editor *inside* the app — if another app (or another VS Code window) is on
 * top, the user still has to alt-tab. This helper performs the OS-level
 * activation so a peer-initiated jump lands in front of the user.
 *
 * Note: `process.pid` inside an extension host is the extension-host helper
 * process, not the Electron main UI process. AppleScript/PowerShell that
 * targets that pid will silently no-op. We instead activate by the app's
 * user-visible name — `vscode.env.appName` resolves to "Visual Studio Code",
 * "Cursor", "CodeBuddy", etc., and `activate` raises the most-recently-used
 * window of that app, which is the one we just opened the document in.
 *
 * Failures are swallowed: we never want focus management to break the jump.
 */
export async function bringWindowToForeground(output: vscode.OutputChannel): Promise<void> {
  try {
    const appName = vscode.env.appName // e.g. "Visual Studio Code", "Cursor"
    switch (process.platform) {
      case 'darwin':
        await focusOnMac(appName)
        break
      case 'win32':
        await focusOnWindows()
        break
      case 'linux':
        await focusOnLinux(appName)
        break
      default:
        // unsupported platform — silently skip
        break
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    output.appendLine(`[window-focus] ignored error: ${msg}`)
  }
}

async function focusOnMac(appName: string): Promise<void> {
  // `activate` on the app raises the most-recently-used window of that app,
  // which is the one we just brought the document into. Using the user-visible
  // app name keeps this working across VS Code, Cursor, CodeBuddy, Insiders.
  const safeName = appName.replace(/"/g, '\\"')
  const script = `tell application "${safeName}" to activate`
  await runDetached('osascript', ['-e', script])
}

async function focusOnWindows(): Promise<void> {
  // Walk up our parent process chain looking for a process that owns a main
  // window — that's the Electron UI process. SetForegroundWindow on that
  // handle raises the IDE.
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@
$pid_ = ${process.pid}
for ($i = 0; $i -lt 6; $i++) {
  $proc = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
  if ($null -eq $proc) { break }
  if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
    [W]::ShowWindowAsync($proc.MainWindowHandle, 9) | Out-Null
    [W]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
    break
  }
  $parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$pid_" -ErrorAction SilentlyContinue).ParentProcessId
  if ($null -eq $parent -or $parent -eq 0 -or $parent -eq $pid_) { break }
  $pid_ = $parent
}
`.trim()
  await runDetached('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps])
}

async function focusOnLinux(appName: string): Promise<void> {
  // Try wmctrl by app class first (works on most X11 WMs); fall back to
  // xdotool. Both are optional packages — if neither is installed we silently
  // skip. We don't use process.pid because of the helper-process issue.
  const lower = appName.toLowerCase().replace(/[^a-z0-9]/g, '')
  const wmctrlCmd = `wmctrl -xa "${lower}" || wmctrl -a "${appName.replace(/"/g, '\\"')}"`
  await runDetached('sh', ['-c', wmctrlCmd]).catch(() => {
    const xdotoolCmd = `xdotool search --name "${appName.replace(/"/g, '\\"')}" | tail -1 | xargs -r xdotool windowactivate`
    return runDetached('sh', ['-c', xdotoolCmd])
  })
}

function runDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: false })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0 || code === null) {
        resolve()
      } else {
        reject(new Error(`${command} exited with code ${code}`))
      }
    })
  })
}
