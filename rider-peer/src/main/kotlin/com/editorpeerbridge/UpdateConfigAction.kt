package com.editorpeerbridge

import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.DumbAwareAction

class UpdateConfigAction : DumbAwareAction() {
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = project.getService(PeerBridgeService::class.java)

        ApplicationManager.getApplication().executeOnPooledThread {
            service.createOrUpdateConfig()
        }
    }
}
