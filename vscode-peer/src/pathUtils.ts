import * as path from 'path'

export function normalizePath(input: string): string {
  const normalized = path.resolve(input).replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function isSameOrChildPath(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizePath(candidate)
  const normalizedRoot = normalizePath(root).replace(/\/$/, '')
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
