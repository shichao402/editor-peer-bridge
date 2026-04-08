package com.editorpeerbridge

import java.nio.file.Path
import java.nio.file.Paths

fun normalizePath(input: String): String {
    val resolved = Paths.get(input).toAbsolutePath().normalize().toString().replace('\\', '/')
    return if (System.getProperty("os.name").startsWith("Windows", ignoreCase = true)) {
        resolved.lowercase()
    } else {
        resolved
    }
}

fun pathMatchesRoots(filePath: String, workspaceRoots: List<String>): Boolean {
    val candidate = normalizePath(filePath)
    return workspaceRoots.any { root ->
        val normalizedRoot = normalizePath(root).trimEnd('/')
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
