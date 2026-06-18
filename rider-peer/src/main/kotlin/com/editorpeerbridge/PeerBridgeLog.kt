package com.editorpeerbridge

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardOpenOption
import java.time.Instant

class PeerBridgeLogger(private val logPath: Path) {
    @Synchronized
    fun appendLine(line: String) {
        try {
            Files.createDirectories(logPath.parent)
            Files.writeString(
                logPath,
                "[${Instant.now()}] $line\n",
                StandardOpenOption.CREATE,
                StandardOpenOption.APPEND,
            )
        } catch (_: Exception) {
            // Ignore file write failures so logging never breaks the plugin.
        }
    }
}

object PeerBridgeLog {
    fun logPathFor(project: Project): Path {
        val safeName = project.name.ifBlank { "project" }
            .replace(Regex("[^a-zA-Z0-9._-]+"), "_")
        return Paths.get(PathManager.getLogPath())
            .resolve("editor-peer-bridge")
            .resolve("$safeName.log")
    }

    fun loggerFor(project: Project): PeerBridgeLogger = PeerBridgeLogger(logPathFor(project))

    fun openLog(project: Project) {
        val logPath = logPathFor(project)
        if (!Files.exists(logPath)) {
            NotificationGroupManager.getInstance()
                .getNotificationGroup("Editor Peer Bridge")
                .createNotification(
                    "Editor Peer Bridge: log file not found yet. Use the plugin to generate logs first.",
                    NotificationType.WARNING,
                )
                .notify(project)
            return
        }

        val normalizedPath = logPath.toString().replace('\\', '/')
        ApplicationManager.getApplication().invokeLater {
            val virtualFile = LocalFileSystem.getInstance().refreshAndFindFileByPath(normalizedPath) ?: run {
                NotificationGroupManager.getInstance()
                    .getNotificationGroup("Editor Peer Bridge")
                    .createNotification("Editor Peer Bridge: log file not found: $normalizedPath", NotificationType.WARNING)
                    .notify(project)
                return@invokeLater
            }
            FileEditorManager.getInstance(project).openTextEditor(OpenFileDescriptor(project, virtualFile), true)
        }
    }
}
