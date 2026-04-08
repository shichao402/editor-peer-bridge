package com.editorpeerbridge

import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.StartupActivity

class PeerStartupActivity : StartupActivity.DumbAware {
    override fun runActivity(project: Project) {
        project.getService(PeerBridgeService::class.java).startServer()
    }
}
