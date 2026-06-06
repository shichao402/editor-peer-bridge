import * as path from 'path'

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:(?:[\\/]|$)/
const WINDOWS_UNC_PATH = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/

export function normalizePath(input: string): string {
  return normalizePathForCompare(input)
}

export function normalizeStoredPath(input: string): string {
  const value = input.trim()
  if (isWindowsStylePath(value)) {
    return trimTrailingSlash(
      toForwardSlashes(path.win32.normalize(value))
        .replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`)
    )
  }

  if (isPosixAbsolutePath(value)) {
    return trimTrailingSlash(path.posix.normalize(toForwardSlashes(value)))
  }

  return trimTrailingSlash(toForwardSlashes(path.resolve(value)))
}

export function isSameOrChildPath(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizePath(candidate)
  const normalizedRoot = normalizePath(root)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
}

export function pathMatchesRoots(filePath: string, roots: string[]): boolean {
  return roots.some((root) => isSameOrChildPath(filePath, root))
}

export function projectTypeMatches(sourceProjectType: string, supportedTypes: string[], typeHierarchy: Record<string, string[]>): boolean {
  return supportedTypes.some((supportedType) => {
    if (supportedType === sourceProjectType) {
      return true
    }

    return includesProjectType(supportedType, sourceProjectType, typeHierarchy, new Set())
  })
}

function includesProjectType(parentType: string, targetType: string, typeHierarchy: Record<string, string[]>, visited: Set<string>): boolean {
  if (visited.has(parentType)) {
    return false
  }

  visited.add(parentType)
  const children = typeHierarchy[parentType] ?? []
  if (children.includes(targetType)) {
    return true
  }

  return children.some((child) => includesProjectType(child, targetType, typeHierarchy, visited))
}

function normalizePathForCompare(input: string): string {
  const value = input.trim()
  if (isWindowsStylePath(value)) {
    return trimTrailingSlash(toForwardSlashes(path.win32.normalize(value))).toLowerCase()
  }

  if (isPosixAbsolutePath(value)) {
    return trimTrailingSlash(path.posix.normalize(toForwardSlashes(value)))
  }

  const normalized = trimTrailingSlash(toForwardSlashes(path.resolve(value)))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isWindowsStylePath(input: string): boolean {
  return WINDOWS_DRIVE_PATH.test(input) || WINDOWS_UNC_PATH.test(input)
}

function isPosixAbsolutePath(input: string): boolean {
  return input.startsWith('/') && !WINDOWS_UNC_PATH.test(input)
}

function toForwardSlashes(input: string): string {
  return input.replace(/\\/g, '/')
}

function trimTrailingSlash(input: string): string {
  if (input === '/' || /^[A-Za-z]:\/$/.test(input) || /^\/\/[^/]+\/[^/]+$/.test(input)) {
    return input
  }

  return input.replace(/\/+$/, '')
}
