package com.editorpeerbridge

import java.nio.file.Path
import java.nio.file.Paths

private val WINDOWS_DRIVE_PATH = Regex("""^[A-Za-z]:(?:[\\/]|$)""")
private val WINDOWS_UNC_PATH = Regex("""^(?:\\\\|//)[^\\/]+[\\/][^\\/]+""")

fun normalizePath(input: String): String {
    return normalizePathForCompare(input)
}

fun normalizeStoredPath(input: String): String {
    val value = input.trim()
    return when {
        isWindowsDrivePath(value) -> normalizeWindowsDrivePath(value)
        isWindowsUncPath(value) -> normalizeWindowsUncPath(value)
        isPosixAbsolutePath(value) -> normalizePosixPath(value)
        else -> trimTrailingSlash(Paths.get(value).toAbsolutePath().normalize().toString().replace('\\', '/'))
    }
}

fun pathMatchesRoots(filePath: String, workspaceRoots: List<String>): Boolean {
    val candidate = normalizePath(filePath)
    return workspaceRoots.any { root ->
        val normalizedRoot = normalizePath(root)
        candidate == normalizedRoot || candidate.startsWith("$normalizedRoot/")
    }
}

fun projectTypeMatches(sourceProjectType: String, supportedProjectTypes: List<String>, typeHierarchy: Map<String, List<String>>): Boolean {
    return supportedProjectTypes.any { supportedType ->
        supportedType == sourceProjectType || containsProjectType(supportedType, sourceProjectType, typeHierarchy, mutableSetOf())
    }
}

private fun containsProjectType(parentType: String, targetType: String, typeHierarchy: Map<String, List<String>>, visited: MutableSet<String>): Boolean {
    if (!visited.add(parentType)) {
        return false
    }

    val children = typeHierarchy[parentType].orEmpty()
    if (children.contains(targetType)) {
        return true
    }

    return children.any { child -> containsProjectType(child, targetType, typeHierarchy, visited) }
}

fun toPath(path: String): Path = Paths.get(path).toAbsolutePath().normalize()

private fun normalizePathForCompare(input: String): String {
    val normalized = normalizeStoredPath(input)
    return if (isWindowsStylePath(input) || System.getProperty("os.name").startsWith("Windows", ignoreCase = true)) {
        normalized.lowercase()
    } else {
        normalized
    }
}

private fun isWindowsStylePath(input: String): Boolean = isWindowsDrivePath(input.trim()) || isWindowsUncPath(input.trim())

private fun isWindowsDrivePath(input: String): Boolean = WINDOWS_DRIVE_PATH.containsMatchIn(input)

private fun isWindowsUncPath(input: String): Boolean = WINDOWS_UNC_PATH.containsMatchIn(input)

private fun isPosixAbsolutePath(input: String): Boolean = input.startsWith("/") && !isWindowsUncPath(input)

private fun normalizeWindowsDrivePath(input: String): String {
    val slashed = input.replace('\\', '/')
    val drive = slashed.substring(0, 1).uppercase() + ":"
    val rest = normalizeSegments(slashed.substring(2).split('/'), allowParentAboveRoot = false)
    return trimTrailingSlash(if (rest.isEmpty()) "$drive/" else "$drive/${rest.joinToString("/")}")
}

private fun normalizeWindowsUncPath(input: String): String {
    val slashed = input.replace('\\', '/')
    val parts = slashed.removePrefix("//").split('/')
    val server = parts.getOrNull(0).orEmpty()
    val share = parts.getOrNull(1).orEmpty()
    val rest = normalizeSegments(parts.drop(2), allowParentAboveRoot = false)
    val prefix = "//$server/$share"
    return trimTrailingSlash(if (rest.isEmpty()) prefix else "$prefix/${rest.joinToString("/")}")
}

private fun normalizePosixPath(input: String): String {
    val parts = input.replace('\\', '/').removePrefix("/").split('/')
    val rest = normalizeSegments(parts, allowParentAboveRoot = false)
    return trimTrailingSlash("/${rest.joinToString("/")}")
}

private fun normalizeSegments(parts: List<String>, allowParentAboveRoot: Boolean): List<String> {
    val result = mutableListOf<String>()
    for (part in parts) {
        when (part) {
            "", "." -> Unit
            ".." -> {
                if (result.isNotEmpty() && result.last() != "..") {
                    result.removeAt(result.lastIndex)
                } else if (allowParentAboveRoot) {
                    result.add(part)
                }
            }
            else -> result.add(part)
        }
    }
    return result
}

private fun trimTrailingSlash(input: String): String {
    if (input == "/" || Regex("""^[A-Za-z]:/$""").matches(input) || Regex("""^//[^/]+/[^/]+$""").matches(input)) {
        return input
    }
    return input.trimEnd('/')
}
