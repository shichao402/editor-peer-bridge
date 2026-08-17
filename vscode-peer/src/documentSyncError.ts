/**
 * Cursor marks some file models as unsyncable with the extension host (its AI
 * indexing sets `skipLSPSync`), and `openTextDocument` then rejects even for
 * small files. The wording differs between builds:
 *   VS Code: "Files above 50MB cannot be synchronized with extensions."
 *   Cursor:  "Documents above the size limit cannot be synchronized with extensions."
 * File size is validated before opening, so any of these means we should retry
 * through the editor command instead of the extension-host document API.
 */
const SYNC_REJECTION_PATTERNS = [
  /cannot be synchronized with extensions/i,
  /above the size limit/i,
  /\b\d+\s*MB\b/i
]

export function isDocumentSyncRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (!message) {
    return false
  }

  return SYNC_REJECTION_PATTERNS.some((pattern) => pattern.test(message))
}
