package com.editorpeerbridge

enum class EditorKind {
    rider,
    vscode,
    cursor,
    codebuddy,
}

data class Position(
    val line: Int,
    val column: Int,
)

data class Range(
    val start: Position,
    val end: Position,
)

data class DocumentRef(
    val filePath: String,
    val selection: Range,
)

data class SourceContext(
    val peerId: String,
    val editorKind: EditorKind,
    val instanceName: String,
    val projectRoot: String,
    val projectType: String,
)

data class TargetHint(
    val peerIds: List<String> = emptyList(),
    val editorKinds: List<EditorKind> = emptyList(),
)

data class OpenLocationOptions(
    val activateWindow: Boolean = true,
    val revealMode: String = "center",
)

data class OpenLocationRequest(
    val source: SourceContext,
    val targetHint: TargetHint? = null,
    val document: DocumentRef,
    val options: OpenLocationOptions = OpenLocationOptions(),
)

data class PeerEntry(
    val peerId: String,
    val editorKind: EditorKind,
    val instanceName: String,
    val port: Int,
    val workspaceRoots: List<String>,
    val supportedProjectTypes: List<String>,
    val projectType: String,
)

data class RoutingConfig(
    val defaultTargetPeerIds: Map<String, String> = emptyMap(),
    val requestTimeoutMs: Long = 3000,
)

data class RawBridgeConfig(
    val peers: Map<String, PeerEntry>,
    val typeHierarchy: Map<String, List<String>>,
    val routing: RoutingConfig? = null,
)

data class BridgeConfig(
    val self: PeerEntry,
    val knownPeers: List<PeerEntry>,
    val typeHierarchy: Map<String, List<String>>,
    val routing: RoutingConfig? = null,
)

data class ErrorBody(
    val code: String,
    val message: String,
    val details: Any? = null,
)

data class ErrorResponse(
    val ok: Boolean = false,
    val requestId: String,
    val protocolVersion: Int = 1,
    val error: ErrorBody,
)

data class SuccessResponse<T>(
    val ok: Boolean = true,
    val requestId: String,
    val protocolVersion: Int = 1,
    val data: T,
)
