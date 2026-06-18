import * as fs from 'fs/promises'
import * as path from 'path'
import * as vscode from 'vscode'

const LOG_FILE_NAME = 'editor-peer-bridge.log'

export function getLogFilePath(context: vscode.ExtensionContext): string {
  return path.join(context.logUri.fsPath, LOG_FILE_NAME)
}

export function attachFileLogging(channel: vscode.OutputChannel, logPath: string): void {
  const appendLine = channel.appendLine.bind(channel)
  channel.appendLine = (value: string): void => {
    appendLine(value)
    void appendToLogFile(logPath, value)
  }
}

async function appendToLogFile(logPath: string, line: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true })
    const timestamp = new Date().toISOString()
    await fs.appendFile(logPath, `[${timestamp}] ${line}\n`, 'utf8')
  } catch {
    // Ignore file write failures so logging never breaks the extension.
  }
}

export async function openLogDocument(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<void> {
  const logPath = getLogFilePath(context)

  try {
    await fs.access(logPath)
  } catch {
    const action = await vscode.window.showWarningMessage(
      'Editor Peer Bridge: log file not found yet. Use the extension to generate logs, or open the output channel.',
      'Show Output'
    )
    if (action === 'Show Output') {
      output.show()
    }
    return
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath))
  await vscode.window.showTextDocument(document)
}
