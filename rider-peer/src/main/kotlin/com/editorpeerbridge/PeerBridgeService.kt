package com.editorpeerbridge

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.ScrollType
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import java.net.ServerSocket
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
    private val httpClient: HttpClient = HttpClient.newBuilder().build()
    private var server: HttpServer? = null
    private var activePort: Int? = null
    private var cachedConfig: BridgeConfig? = null
    private var configCacheTime: Long = 0
    private val CONFIG_CACHE_TTL_MS = 5000L  // 5 second cache
    private val MAX_REQUEST_BODY_SIZE = 1 * 1024 * 1024L  // 1 MB max

    fun startServer() {
        ensureConfig()
        val config = loadConfigOrNull() ?: return
        if (server != null && activePort == config.self.port) {
            return
        }

        stopServer()

        val created = HttpServer.create(InetSocketAddress("127.0.0.1", config.self.port), 0)
        created.executor = Executors.newCachedThreadPool()
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

        created.start()
        server = created
        activePort = config.self.port
    }

    fun stopServer() {
        server?.stop(0)
        server = null
        activePort = null
    }

    fun jumpToPeer(editor: Editor, file: VirtualFile) {
        try {
            val config = loadConfigOrNull() ?: run {
                notify("Bridge config not found: .editor-peer-bridge.json", NotificationType.WARNING)
                return
            }

            val request = ReadAction.compute<OpenLocationRequest, RuntimeException> {
                buildOpenLocationRequest(config, editor, file)
            }
            val candidates = resolveTargetPeers(config, request)

            if (candidates.isEmpty()) {
                notify("No matching peer found for ${file.path}", NotificationType.WARNING)
                return
            }

            if (candidates.size == 1) {
                sendToPeer(candidates[0], request, config, activateWindow = true)
                return
            }

            // Multiple candidates: show popup with "All" option
            showPeerChooser(candidates, request, config, editor)
        } catch (error: Exception) {
            notify("Jump failed: ${error.message ?: "Unexpected error."}", NotificationType.ERROR)
        }
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

        com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
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
                    com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
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
            notify("Jump to ${target.instanceName} failed: ${response.error.message}", NotificationType.ERROR)
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
                error = ErrorBody("REQUEST_FAILED", error.message ?: "Peer request failed."),
            )
        }
    }

    private fun handleExchange(exchange: HttpExchange, handler: (String, String) -> Any) {
        val requestId = exchange.requestHeaders.getFirst("X-Editor-Peer-Request-Id") ?: UUID.randomUUID().toString()

        try {
            // Check Content-Length before reading
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
        } catch (error: Exception) {
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

        com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
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
        }
    }

    private fun logicalPositionToOffset(document: com.intellij.openapi.editor.Document, position: Position): Int {
        val lineIndex = (position.line - 1).coerceIn(0, document.lineCount - 1)
        val lineStart = document.getLineStartOffset(lineIndex)
        val lineEnd = document.getLineEndOffset(lineIndex)
        return (lineStart + (position.column - 1)).coerceIn(lineStart, lineEnd)
    }

    // ── Auto-config: ensure config exists and self is registered ──

    private fun ensureConfig() {
        val basePath = project.basePath ?: return
        val editorKind = EditorKind.rider
        val explicitPeerId = System.getProperty("editor.peer.bridge.peerId")

        val existingFile = findConfigFile(basePath)
        if (existingFile != null) {
            ensureSelfInConfig(existingFile, editorKind, basePath, explicitPeerId)
        } else {
            createInitialConfig(basePath, editorKind)
        }
    }

    private fun ensureSelfInConfig(configFile: File, editorKind: EditorKind, workspaceRoot: String, explicitPeerId: String?) {
        val raw = mapper.readValue(configFile, RawBridgeConfig::class.java)
        val entries = raw.peers.values.toList()

        // Check if self already exists
        if (explicitPeerId != null) {
            if (entries.any { it.peerId == explicitPeerId }) return
        } else {
            if (entries.any { it.editorKind == editorKind }) return
        }

        // Self not found - register
        val usedPorts = entries.map { it.port }.toSet()
        val port = findAvailablePort(usedPorts)
        val peerId = generatePeerId(editorKind, entries)
        val instanceName = generateInstanceName(editorKind, entries)

        val newPeer = PeerEntry(
            peerId = peerId,
            editorKind = editorKind,
            instanceName = instanceName,
            port = port,
            workspaceRoots = listOf(workspaceRoot),
            supportedProjectTypes = listOf("all"),
            projectType = "all",
        )

        val updatedPeers = raw.peers.toMutableMap()
        updatedPeers[peerId] = newPeer
        val updated = raw.copy(peers = updatedPeers)
        configFile.writeText(mapper.writerWithDefaultPrettyPrinter().writeValueAsString(updated) + "\n")
    }

    private fun createInitialConfig(workspaceRoot: String, editorKind: EditorKind) {
        val port = findAvailablePort(emptySet())
        val peerId = "${editorKind.name}-01"
        val instanceName = "${editorKind.name.replaceFirstChar { it.uppercase() }} 01"

        val config = RawBridgeConfig(
            peers = mapOf(
                peerId to PeerEntry(
                    peerId = peerId,
                    editorKind = editorKind,
                    instanceName = instanceName,
                    port = port,
                    workspaceRoots = listOf(workspaceRoot),
                    supportedProjectTypes = listOf("all"),
                    projectType = "all",
                ),
            ),
            typeHierarchy = mapOf("all" to emptyList()),
            routing = RoutingConfig(requestTimeoutMs = 3000),
        )

        val configFile = File(workspaceRoot, ".editor-peer-bridge.json")
        configFile.writeText(mapper.writerWithDefaultPrettyPrinter().writeValueAsString(config) + "\n")
    }

    private fun generatePeerId(editorKind: EditorKind, existingPeers: List<PeerEntry>): String {
        val samePeers = existingPeers.filter { it.editorKind == editorKind }
        val num = (samePeers.size + 1).toString().padStart(2, '0')
        return "${editorKind.name}-$num"
    }

    private fun generateInstanceName(editorKind: EditorKind, existingPeers: List<PeerEntry>): String {
        val samePeers = existingPeers.filter { it.editorKind == editorKind }
        val num = (samePeers.size + 1).toString().padStart(2, '0')
        return "${editorKind.name.replaceFirstChar { it.uppercase() }} $num"
    }

    companion object {
        private const val PORT_RANGE_START = 47631
        private const val PORT_RANGE_END = 47700
    }

    private fun findAvailablePort(usedPorts: Set<Int>): Int {
        for (port in PORT_RANGE_START..PORT_RANGE_END) {
            if (port in usedPorts) continue
            try {
                ServerSocket(port, 1, java.net.InetAddress.getByName("127.0.0.1")).use { return port }
            } catch (_: Exception) {
                // port in use
            }
        }
        throw IllegalStateException("No available port found in range $PORT_RANGE_START-$PORT_RANGE_END")
    }

    // ── Config loading ──

    private fun loadConfigOrNull(): BridgeConfig? {
        // Use cached config if available and not stale
        val now = System.currentTimeMillis()
        if (cachedConfig != null && (now - configCacheTime) < CONFIG_CACHE_TTL_MS) {
            return cachedConfig
        }

        val basePath = project.basePath ?: return null
        val configFile = findConfigFile(basePath) ?: return null
        val raw = mapper.readValue(configFile, RawBridgeConfig::class.java)
        val config = resolveBridgeConfig(raw, EditorKind.rider)
        
        // Cache the config
        cachedConfig = config
        configCacheTime = now
        
        return config
    }

    private fun findConfigFile(startPath: String): File? {
        var current: File? = File(startPath).absoluteFile
        while (current != null) {
            val candidate = File(current, ".editor-peer-bridge.json")
            if (candidate.exists()) {
                return candidate
            }
            current = current.parentFile
        }
        return null
    }

    private fun resolveBridgeConfig(raw: RawBridgeConfig, myEditorKind: EditorKind): BridgeConfig {
        val entries = raw.peers.values.toList()

        // Allow explicit peerId selection via JVM property (supports multiple instances of same editorKind)
        val explicitPeerId = System.getProperty("editor.peer.bridge.peerId")
        val self = if (explicitPeerId != null) {
            entries.firstOrNull { it.peerId == explicitPeerId }
                ?: throw IllegalStateException("No peer entry found for peerId '$explicitPeerId' in .editor-peer-bridge.json")
        } else {
            entries.firstOrNull { it.editorKind == myEditorKind }
                ?: throw IllegalStateException("No peer entry found for editorKind '$myEditorKind' in .editor-peer-bridge.json")
        }

        val knownPeers = entries.filter { it.peerId != self.peerId }
        return BridgeConfig(
            self = self,
            knownPeers = knownPeers,
            typeHierarchy = raw.typeHierarchy,
            routing = raw.routing,
        )
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
        stopServer()
        // Clear config cache to free memory
        cachedConfig = null
        configCacheTime = 0
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
