package com.editorpeerbridge

import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.intellij.ide.impl.ProjectUtil
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.ScrollType
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.util.Computable
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.util.Alarm
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.io.IOException
import java.net.BindException
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.UUID
import java.util.concurrent.Executors

@Service(Service.Level.PROJECT)
class PeerBridgeService(private val project: Project) : Disposable {
    private val mapper: ObjectMapper = jacksonObjectMapper()
        .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
    private val httpClient: HttpClient = HttpClient.newBuilder().build()
    private val logger = PeerBridgeLog.loggerFor(project)
    private val reconcileAlarm = Alarm(Alarm.ThreadToUse.POOLED_THREAD, this)
    private var server: HttpServer? = null
    private var activePort: Int? = null
    private var cachedConfig: BridgeConfig? = null
    private var configCacheTime: Long = 0
    private var lastKnownSelfPeer: PeerEntry? = null
    private var watchedConfigPath: String? = null
    private var vfsConnection: com.intellij.util.messages.MessageBusConnection? = null
    private var inflightReconcile = false
    private var pendingReconcile = false
    private val CONFIG_CACHE_TTL_MS = 5000L
    private val MAX_REQUEST_BODY_SIZE = 1 * 1024 * 1024L

    fun reconcile(showNotification: Boolean = false): BridgeConfigSupport.EnsureConfigResult {
        if (inflightReconcile) {
            pendingReconcile = true
            return BridgeConfigSupport.EnsureConfigResult(
                status = BridgeConfigSupport.EnsureConfigStatus.SKIPPED,
                changes = listOf("Reconcile already in progress."),
            )
        }

        inflightReconcile = true
        return try {
            val outcome = runReconcile()
            if (showNotification) {
                notify(formatConfigOutcomeMessage(outcome), NotificationType.INFORMATION)
            }
            outcome
        } finally {
            inflightReconcile = false
            if (pendingReconcile) {
                pendingReconcile = false
                reconcile(showNotification)
            }
        }
    }

    fun restartServer(showNotification: Boolean = true): BridgeConfigSupport.EnsureConfigResult {
        val previousPort = activePort
        stopServer()
        lastKnownSelfPeer = null
        if (previousPort != null) {
            log("[controller] stopped server on port $previousPort for manual restart.")
        } else {
            log("[controller] server was not listening; starting fresh.")
        }

        return try {
            val outcome = reconcile(showNotification = false)
            if (showNotification) {
                val portSuffix = activePort?.let { " Server is listening on port $it." } ?: ""
                notify("Editor Peer Bridge: server restarted.$portSuffix", NotificationType.INFORMATION)
            }
            outcome
        } catch (error: Exception) {
            val message = error.message ?: "Unexpected error."
            log("[command] restart failed: $message")
            if (showNotification) {
                notify("Editor Peer Bridge: restart failed — $message", NotificationType.ERROR)
            }
            throw error
        }
    }

    fun startServer() {
        reconcile()
    }

    fun stopServer() {
        server?.stop(0)
        server = null
        activePort = null
    }

    fun createOrUpdateConfig(showNotification: Boolean = true) {
        try {
            reconcile(showNotification = showNotification)
        } catch (error: Exception) {
            notify("Config update failed: ${error.message ?: "Unexpected error."}", NotificationType.ERROR)
        }
    }

    fun openConfig() {
        try {
            val basePath = project.basePath ?: run {
                notify("Project base path not found.", NotificationType.WARNING)
                return
            }
            var configFile = BridgeConfigSupport.findConfigFile(basePath)
            if (configFile == null) {
                reconcile(showNotification = false)
                configFile = BridgeConfigSupport.findConfigFile(basePath)
            }

            if (configFile == null) {
                notify("Config not found: ${BridgeConfigSupport.CONFIG_FILE_NAME}", NotificationType.WARNING)
                return
            }

            openConfigFile(configFile)
        } catch (error: Exception) {
            notify("Open config failed: ${error.message ?: "Unexpected error."}", NotificationType.ERROR)
        }
    }

    private fun openConfigFile(configFile: File) {
        val normalizedPath = configFile.absolutePath.replace('\\', '/')
        ApplicationManager.getApplication().invokeLater {
            val virtualFile = LocalFileSystem.getInstance().refreshAndFindFileByPath(normalizedPath) ?: run {
                notify("Config file not found: $normalizedPath", NotificationType.WARNING)
                return@invokeLater
            }
            FileEditorManager.getInstance(project).openTextEditor(OpenFileDescriptor(project, virtualFile), true)
        }
    }

    fun jumpToPeer(editor: Editor, file: VirtualFile) {
        try {
            val config = loadConfigOrNull() ?: run {
                notify("Bridge config not found: ${BridgeConfigSupport.CONFIG_FILE_NAME}", NotificationType.WARNING)
                return
            }

            val request = ApplicationManager.getApplication().runReadAction(Computable {
                buildOpenLocationRequest(config, editor, file)
            })
            val candidates = resolveTargetPeers(config, request)

            if (candidates.isEmpty()) {
                notify("No matching peer found for ${file.path}", NotificationType.WARNING)
                return
            }

            if (candidates.size == 1) {
                sendToPeer(candidates[0], request, config, activateWindow = true)
                return
            }

            showPeerChooser(candidates, request, config, editor)
        } catch (error: Exception) {
            notify("Jump failed: ${error.message ?: "Unexpected error."}", NotificationType.ERROR)
        }
    }

    private fun runReconcile(): BridgeConfigSupport.EnsureConfigResult {
        val basePath = project.basePath
        val configResult = BridgeConfigSupport.ensureConfig(
            workspaceRoot = basePath,
            editorKind = EditorKind.rider,
            explicitPeerId = System.getProperty("editor.peer.bridge.peerId"),
            solutionName = detectSolutionName(),
        )

        log("[config] ${configResult.status}${configResult.configPath?.let { ": $it" } ?: ""}")
        for (change in configResult.changes) {
            log("[config] $change")
        }

        if (configResult.status == BridgeConfigSupport.EnsureConfigStatus.SKIPPED) {
            stopServer()
            return configResult
        }

        ensureConfigWatcher(configResult.configPath)

        val config = try {
            loadConfigOrNull(forceReload = true)
        } catch (error: Exception) {
            log("[controller] failed to load config: ${error.message}")
            throw error
        } ?: run {
            stopServer()
            return configResult
        }

        val shouldRestartForSelfChange = BridgeConfigSupport.selfPeerConfigChanged(lastKnownSelfPeer, config.self)
        if (shouldRestartForSelfChange) {
            val previousPort = activePort
            stopServer()
            if (previousPort != null) {
                log("[controller] self peer config changed, stopped server on port $previousPort before restart.")
            } else {
                log("[controller] self peer config changed, restarting server.")
            }
        } else if (server != null && activePort == config.self.port) {
            lastKnownSelfPeer = config.self
            return configResult
        }

        stopServer()

        val resolvedConfig = try {
            val configuredPort = config.self.port
            var listeningConfig = ensureListening(config, configResult.configPath)
            if (listeningConfig.self.port != configuredPort) {
                loadConfigOrNull(forceReload = true)?.let { listeningConfig = it }
            }
            listeningConfig
        } catch (error: Exception) {
            log("[controller] ensureListening failed: ${error.message ?: error.toString()}")
            throw error
        }

        lastKnownSelfPeer = resolvedConfig.self
        return configResult
    }

    /**
     * Make the server listen on [BridgeConfig.self] port. If that port is taken,
     * pick the next available port in the configured range, persist it, and listen there.
     */
    private fun ensureListening(config: BridgeConfig, configPath: String?): BridgeConfig {
        val desiredPort = config.self.port

        if (tryStartServer(config, desiredPort)) {
            return config
        }

        val usedByOtherPeers = (config.knownPeers.map { it.port } + desiredPort).toSet()
        val fallbackPort = try {
            BridgeConfigSupport.findAvailablePort(usedByOtherPeers)
        } catch (error: Exception) {
            log("[peer-server] failed: ${error.message ?: error.toString()}")
            throw error
        }

        val listeningConfig = config.copy(self = config.self.copy(port = fallbackPort))
        if (!tryStartServer(listeningConfig, fallbackPort)) {
            val message = "Failed to listen on fallback port $fallbackPort"
            log("[peer-server] failed: $message")
            throw IllegalStateException(message)
        }

        log("[peer-server] port $desiredPort was busy, switched to $fallbackPort.")

        if (configPath != null) {
            try {
                BridgeConfigSupport.updateSelfPort(File(configPath), config.self.peerId, fallbackPort)
                log("[controller] persisted port $desiredPort → $fallbackPort for peer ${config.self.peerId}.")
            } catch (writeError: Exception) {
                log("[peer-server] failed to persist new port: ${writeError.message ?: writeError.toString()}")
            }
        }

        return listeningConfig
    }

    private fun tryStartServer(config: BridgeConfig, port: Int): Boolean {
        return try {
            val created = HttpServer.create(InetSocketAddress("127.0.0.1", port), 0)
            created.executor = Executors.newCachedThreadPool()
            bindServerContexts(created, config)
            created.start()
            server = created
            activePort = port
            log("[peer-server] listening on 127.0.0.1:$port")
            true
        } catch (error: Exception) {
            if (isAddressInUse(error)) {
                false
            } else {
                throw error
            }
        }
    }

    private fun isAddressInUse(error: Exception): Boolean {
        if (error is BindException) {
            return true
        }
        var cause: Throwable? = error.cause
        while (cause != null) {
            if (cause is BindException) {
                return true
            }
            cause = cause.cause
        }
        return error is IOException && error.message?.contains("Address already in use", ignoreCase = true) == true
    }

    private fun bindServerContexts(created: HttpServer, config: BridgeConfig) {
        created.createContext("/peer/v1/info") { exchange ->
            handleExchange(exchange) { _, requestId ->
                success(
                    requestId,
                    mapOf(
                        "identity" to mapOf(
                            "peerId" to config.self.peerId,
                            "editorKind" to config.self.editorKind,
                            "instanceName" to config.self.instanceName,
                            "version" to "0.0.1",
                        ),
                        "workspaceRoots" to config.self.workspaceRoots,
                        "supportedProjectTypes" to config.self.supportedProjectTypes,
                        "capabilities" to mapOf(
                            "openLocation" to true,
                            "restoreSelection" to true,
                            "activateWindow" to true,
                        ),
                        "server" to mapOf("port" to config.self.port),
                    ),
                )
            }
        }
        created.createContext("/peer/v1/ping") { exchange ->
            handleExchange(exchange) { _, requestId ->
                success(requestId, mapOf("status" to "alive"))
            }
        }
        created.createContext("/peer/v1/can-handle") { exchange ->
            handleExchange(exchange) { body, requestId ->
                val request = mapper.readValue(body, OpenLocationRequest::class.java)
                success(
                    requestId,
                    mapOf(
                        "canHandle" to canCurrentPeerHandle(config, request),
                        "reason" to if (canCurrentPeerHandle(config, request)) "MATCHED" else "NOT_MATCHED",
                    ),
                )
            }
        }
        created.createContext("/peer/v1/open-location") { exchange ->
            handleExchange(exchange) { body, requestId ->
                val request = mapper.readValue(body, OpenLocationRequest::class.java)
                validateRequest(request)?.let { validationMessage ->
                    return@handleExchange error(requestId, "INVALID_REQUEST", validationMessage) to 400
                }

                getMatchError(config, request)?.let { matchError ->
                    return@handleExchange error(requestId, matchError.code, matchError.message, matchError.details) to 409
                }

                val file = File(request.document.filePath)
                if (!file.exists()) {
                    return@handleExchange error(
                        requestId,
                        "FILE_NOT_FOUND",
                        "Requested file does not exist.",
                        mapOf("filePath" to request.document.filePath),
                    ) to 404
                }

                openInRider(request)
                success(
                    requestId,
                    mapOf(
                        "targetPeerId" to config.self.peerId,
                        "openedFile" to request.document.filePath,
                        "selectionApplied" to true,
                        "windowActivated" to request.options.activateWindow,
                    ),
                ) to 200
            }
        }
    }

    private fun ensureConfigWatcher(configPath: String?) {
        if (configPath == null || watchedConfigPath == configPath) {
            return
        }

        vfsConnection?.disconnect()
        watchedConfigPath = configPath
        val normalizedPath = configPath.replace('\\', '/')
        LocalFileSystem.getInstance().refreshAndFindFileByPath(normalizedPath)

        val connection = project.messageBus.connect(this)
        vfsConnection = connection
        connection.subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
            override fun after(events: List<VFileEvent>) {
                val relevant = events.any { event ->
                    event.file?.path?.replace('\\', '/') == normalizedPath
                }
                if (relevant) {
                    log("[controller] config change detected, scheduling reconcile.")
                    scheduleReconcile()
                }
            }
        })
    }

    private fun scheduleReconcile() {
        reconcileAlarm.cancelAllRequests()
        reconcileAlarm.addRequest({ reconcile() }, 150)
    }

    private fun showPeerChooser(
        candidates: List<PeerEntry>,
        request: OpenLocationRequest,
        config: BridgeConfig,
        editor: Editor,
    ) {
        data class PeerChoice(val peer: PeerEntry?, val label: String, val isAll: Boolean = false)

        val choices = mutableListOf<PeerChoice>()
        choices.add(PeerChoice(peer = null, label = "All (${candidates.size} peers)", isAll = true))
        candidates.forEach { peer ->
            choices.add(PeerChoice(peer = peer, label = "${peer.instanceName} (${peer.editorKind} · :${peer.port})"))
        }

        ApplicationManager.getApplication().invokeLater {
            JBPopupFactory.getInstance()
                .createPopupChooserBuilder(choices)
                .setTitle("Jump to Peer")
                .setRenderer(javax.swing.ListCellRenderer { _, value, _, isSelected, _ ->
                    javax.swing.JLabel(value.label).apply {
                        isOpaque = true
                        if (isSelected) {
                            background = javax.swing.UIManager.getColor("List.selectionBackground")
                            foreground = javax.swing.UIManager.getColor("List.selectionForeground")
                        }
                    }
                })
                .setItemChosenCallback { choice ->
                    ApplicationManager.getApplication().executeOnPooledThread {
                        if (choice.isAll) {
                            broadcastToPeers(candidates, request, config)
                        } else {
                            choice.peer?.let { sendToPeer(it, request, config, activateWindow = true) }
                        }
                    }
                }
                .createPopup()
                .showInBestPositionFor(editor)
        }
    }

    private fun sendToPeer(target: PeerEntry, request: OpenLocationRequest, config: BridgeConfig, activateWindow: Boolean) {
        val actualRequest = if (!activateWindow) {
            request.copy(options = request.options.copy(activateWindow = false))
        } else {
            request
        }
        val timeoutMs = config.routing?.requestTimeoutMs ?: 3000
        val response = postOpenLocation(target, actualRequest, timeoutMs)
        if (response.ok) {
            notify("Jumped to ${target.instanceName}", NotificationType.INFORMATION)
        } else {
            log("[peer-client] open-location to ${target.instanceName} failed: ${response.error.code} ${response.error.message}")
            notify("${target.instanceName} - ${response.error.message}", NotificationType.ERROR)
        }
    }

    private fun broadcastToPeers(targets: List<PeerEntry>, request: OpenLocationRequest, config: BridgeConfig) {
        val results = targets.map { target -> target to sendToPeerQuietly(target, request, config) }
        val succeeded = results.count { it.second }
        val failed = results.count { !it.second }
        if (failed == 0) {
            notify("Jumped to all $succeeded peers", NotificationType.INFORMATION)
        } else {
            notify("Jumped to $succeeded peers, $failed failed", NotificationType.WARNING)
        }
    }

    private fun sendToPeerQuietly(target: PeerEntry, request: OpenLocationRequest, config: BridgeConfig): Boolean {
        val quietRequest = request.copy(options = request.options.copy(activateWindow = false))
        val timeoutMs = config.routing?.requestTimeoutMs ?: 3000
        return postOpenLocation(target, quietRequest, timeoutMs).ok
    }

    private fun buildOpenLocationRequest(config: BridgeConfig, editor: Editor, file: VirtualFile): OpenLocationRequest {
        val selectionModel = editor.selectionModel
        val startPosition = editor.offsetToLogicalPosition(selectionModel.selectionStart)
        val endOffset = if (selectionModel.hasSelection()) selectionModel.selectionEnd else selectionModel.selectionStart
        val endPosition = editor.offsetToLogicalPosition(endOffset)

        return OpenLocationRequest(
            source = SourceContext(
                peerId = config.self.peerId,
                editorKind = config.self.editorKind,
                instanceName = config.self.instanceName,
                projectRoot = config.self.workspaceRoots.first(),
                projectType = config.self.projectType,
            ),
            document = DocumentRef(
                filePath = file.path,
                selection = Range(
                    start = Position(startPosition.line + 1, startPosition.column + 1),
                    end = Position(endPosition.line + 1, endPosition.column + 1),
                ),
            ),
            options = OpenLocationOptions(),
        )
    }

    private fun resolveTargetPeers(config: BridgeConfig, request: OpenLocationRequest): List<PeerEntry> {
        return config.knownPeers.filter { peer: PeerEntry ->
            request.targetHint?.peerIds?.takeIf { it.isNotEmpty() }?.contains(peer.peerId) != false &&
                request.targetHint?.editorKinds?.takeIf { it.isNotEmpty() }?.contains(peer.editorKind) != false &&
                pathMatchesRoots(request.document.filePath, peer.workspaceRoots) &&
                projectTypeMatches(request.source.projectType, peer.supportedProjectTypes, config.typeHierarchy)
        }
    }

    private fun postOpenLocation(target: PeerEntry, request: OpenLocationRequest, timeoutMs: Long): ErrorOrSuccess {
        val requestId = UUID.randomUUID().toString()
        val requestBody = mapper.writeValueAsString(request)
        val httpRequest = HttpRequest.newBuilder()
            .uri(URI.create("http://127.0.0.1:${target.port}/peer/v1/open-location"))
            .timeout(Duration.ofMillis(timeoutMs))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .header("X-Editor-Peer-Protocol-Version", "1")
            .header("X-Editor-Peer-Request-Id", requestId)
            .header("X-Editor-Peer-Source", request.source.peerId)
            .POST(HttpRequest.BodyPublishers.ofString(requestBody))
            .build()

        return try {
            val response = httpClient.send(httpRequest, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
            if (response.statusCode() in 200..299) {
                ErrorOrSuccess(ok = true)
            } else {
                val root = mapper.readTree(response.body())
                ErrorOrSuccess(
                    ok = false,
                    error = ErrorBody(
                        code = root.path("error").path("code").asText("UNKNOWN_ERROR"),
                        message = root.path("error").path("message").asText("Unknown peer error."),
                    ),
                )
            }
        } catch (error: Exception) {
            ErrorOrSuccess(
                ok = false,
                error = ErrorBody("REQUEST_FAILED", formatRequestFailedMessage(target, error)),
            )
        }
    }

    private fun formatRequestFailedMessage(peer: PeerEntry, error: Exception): String {
        val cause = error.cause
        if (error is ConnectException || cause is ConnectException) {
            return "Connection refused — is ${peer.instanceName} (${peer.editorKind}) running on port ${peer.port}?"
        }

        val message = error.message.orEmpty()
        if (message.contains("Connection refused", ignoreCase = true)) {
            return "Connection refused — is ${peer.instanceName} (${peer.editorKind}) running on port ${peer.port}?"
        }

        return cause?.message?.takeIf { it.isNotBlank() } ?: message.ifBlank { "Request failed" }
    }

    private fun handleExchange(exchange: HttpExchange, handler: (String, String) -> Any) {
        val requestId = exchange.requestHeaders.getFirst("X-Editor-Peer-Request-Id") ?: UUID.randomUUID().toString()

        try {
            val contentLength = exchange.requestHeaders.getFirst("Content-Length")?.toLongOrNull()
            if (contentLength != null && contentLength > MAX_REQUEST_BODY_SIZE) {
                respondJson(exchange, 413, error(requestId, "REQUEST_TOO_LARGE", "Request body exceeds $MAX_REQUEST_BODY_SIZE bytes"))
                return
            }

            val body = exchange.requestBody.readAllBytes().toString(StandardCharsets.UTF_8)
            val result = handler(body, requestId)
            val (payload, statusCode) = when (result) {
                is Pair<*, *> -> result.first to (result.second as Int)
                else -> result to 200
            }
            respondJson(exchange, statusCode, payload)
        } catch (error: Exception) {
            respondJson(exchange, 500, error(requestId, "INTERNAL_ERROR", error.message ?: "Unexpected server error."))
        } finally {
            exchange.close()
        }
    }

    private fun respondJson(exchange: HttpExchange, statusCode: Int, payload: Any?) {
        try {
            val raw = mapper.writeValueAsBytes(payload)
            exchange.responseHeaders.add("Content-Type", "application/json; charset=utf-8")
            exchange.sendResponseHeaders(statusCode, raw.size.toLong())
            exchange.responseBody.use { output ->
                output.write(raw)
                output.flush()
            }
        } catch (_: Exception) {
            exchange.responseBody.close()
        }
    }

    private fun validateRequest(request: OpenLocationRequest): String? {
        if (request.source.peerId.isBlank()) {
            return "Missing source.peerId."
        }
        if (request.document.filePath.isBlank()) {
            return "Missing document.filePath."
        }
        if (request.document.selection.start.line < 1 || request.document.selection.end.line < 1) {
            return "Line numbers must be positive."
        }
        if (request.document.selection.start.column < 1 || request.document.selection.end.column < 1) {
            return "Column numbers must be positive."
        }
        return null
    }

    private fun getMatchError(config: BridgeConfig, request: OpenLocationRequest): MatchError? {
        if (!request.targetHint?.peerIds.isNullOrEmpty() && !request.targetHint!!.peerIds.contains(config.self.peerId)) {
            return MatchError("TARGET_HINT_MISMATCH", "Current peer is not listed in targetHint.peerIds.")
        }
        if (!request.targetHint?.editorKinds.isNullOrEmpty() && !request.targetHint!!.editorKinds.contains(config.self.editorKind)) {
            return MatchError("TARGET_HINT_MISMATCH", "Current peer editor kind is not listed in targetHint.editorKinds.")
        }
        if (!canCurrentPeerHandle(config, request)) {
            return MatchError(
                "PROJECT_ROOT_OR_TYPE_MISMATCH",
                "Current peer does not match the incoming request by workspace root or project type.",
                mapOf(
                    "filePath" to request.document.filePath,
                    "workspaceRoots" to config.self.workspaceRoots,
                    "sourceProjectType" to request.source.projectType,
                    "supportedProjectTypes" to config.self.supportedProjectTypes,
                ),
            )
        }
        return null
    }

    private fun canCurrentPeerHandle(config: BridgeConfig, request: OpenLocationRequest): Boolean {
        return pathMatchesRoots(request.document.filePath, config.self.workspaceRoots) &&
            projectTypeMatches(request.source.projectType, config.self.supportedProjectTypes, config.typeHierarchy)
    }

    private fun openInRider(request: OpenLocationRequest) {
        val normalizedPath = request.document.filePath.replace('\\', '/')
        val virtualFile = LocalFileSystem.getInstance().refreshAndFindFileByPath(normalizedPath)
            ?: throw IllegalStateException("Requested file does not exist in Rider filesystem: $normalizedPath")

        val focusOnJump = isFocusOnJumpEnabled(loadConfigOrNull())

        ApplicationManager.getApplication().invokeLater {
            val descriptor = OpenFileDescriptor(
                project,
                virtualFile,
                request.document.selection.start.line - 1,
                request.document.selection.start.column - 1,
            )
            val editor = FileEditorManager.getInstance(project).openTextEditor(descriptor, request.options.activateWindow)
                ?: return@invokeLater

            val document = editor.document
            val startOffset = logicalPositionToOffset(document, request.document.selection.start)
            val endOffset = logicalPositionToOffset(document, request.document.selection.end)
            editor.selectionModel.setSelection(startOffset, endOffset)
            editor.scrollingModel.scrollToCaret(ScrollType.CENTER)

            if (request.options.activateWindow && focusOnJump) {
                try {
                    ProjectUtil.focusProjectWindow(project, true)
                } catch (_: Throwable) {
                    // best-effort
                }
            }
        }
    }

    private fun isFocusOnJumpEnabled(config: BridgeConfig?): Boolean {
        return config?.ui?.focusOnJump == true
    }

    private fun logicalPositionToOffset(document: com.intellij.openapi.editor.Document, position: Position): Int {
        val lineIndex = (position.line - 1).coerceIn(0, document.lineCount - 1)
        val lineStart = document.getLineStartOffset(lineIndex)
        val lineEnd = document.getLineEndOffset(lineIndex)
        return (lineStart + (position.column - 1)).coerceIn(lineStart, lineEnd)
    }

    private fun detectSolutionName(): String? {
        val name = project.name
        if (name.isBlank()) return null
        return name.lowercase()
            .replace(Regex("[^a-z0-9]+"), "-")
            .trim('-')
            .ifEmpty { null }
    }

    private fun loadConfigOrNull(forceReload: Boolean = false): BridgeConfig? {
        val now = System.currentTimeMillis()
        if (!forceReload && cachedConfig != null && (now - configCacheTime) < CONFIG_CACHE_TTL_MS) {
            return cachedConfig
        }

        val basePath = project.basePath ?: return null
        val configFile = BridgeConfigSupport.findConfigFile(basePath) ?: return null
        val config = BridgeConfigSupport.loadBridgeConfig(configFile, EditorKind.rider, detectSolutionName())
        cachedConfig = config
        configCacheTime = now
        return config
    }

    private fun formatConfigOutcomeMessage(result: BridgeConfigSupport.EnsureConfigResult): String {
        return when (result.status) {
            BridgeConfigSupport.EnsureConfigStatus.CREATED -> "Editor Peer Bridge: created config."
            BridgeConfigSupport.EnsureConfigStatus.UPDATED -> "Editor Peer Bridge: updated config."
            BridgeConfigSupport.EnsureConfigStatus.UNCHANGED -> "Editor Peer Bridge: config is already up to date."
            BridgeConfigSupport.EnsureConfigStatus.SKIPPED -> "Editor Peer Bridge: ${result.changes.firstOrNull() ?: "config skipped."}"
        }
    }

    private fun log(line: String) {
        logger.appendLine(line)
    }

    private fun notify(message: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("Editor Peer Bridge")
            .createNotification(message, type)
            .notify(project)
    }

    private fun success(requestId: String, data: Any): SuccessResponse<Any> = SuccessResponse(requestId = requestId, data = data)

    private fun error(requestId: String, code: String, message: String, details: Any? = null): ErrorResponse =
        ErrorResponse(requestId = requestId, error = ErrorBody(code, message, details))

    override fun dispose() {
        reconcileAlarm.cancelAllRequests()
        vfsConnection?.disconnect()
        vfsConnection = null
        watchedConfigPath = null
        stopServer()
        cachedConfig = null
        configCacheTime = 0
        lastKnownSelfPeer = null
    }
}

data class MatchError(
    val code: String,
    val message: String,
    val details: Any? = null,
)

data class ErrorOrSuccess(
    val ok: Boolean,
    val error: ErrorBody = ErrorBody("", ""),
)
