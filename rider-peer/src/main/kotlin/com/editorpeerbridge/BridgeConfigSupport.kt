package com.editorpeerbridge

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import java.io.File
import java.net.ServerSocket

object BridgeConfigSupport {
    const val CONFIG_FILE_NAME = ".editor-peer-bridge.json"
    const val PORT_RANGE_START = 47631
    const val PORT_RANGE_END = 47700

    private val mapper: ObjectMapper = jacksonObjectMapper()

    enum class EnsureConfigStatus { CREATED, UPDATED, UNCHANGED, SKIPPED }

    data class EnsureConfigResult(
        val status: EnsureConfigStatus,
        val configPath: String? = null,
        val peerId: String? = null,
        val changes: List<String> = emptyList(),
    )

    private data class ParsedBridgeConfig(
        val raw: RawBridgeConfig,
        val warnings: List<String>,
    )

    private sealed class ParseBridgeConfigResult {
        data class Ok(val parsed: ParsedBridgeConfig) : ParseBridgeConfigResult()
        data class Fail(val error: String) : ParseBridgeConfigResult()
    }

    fun findConfigFile(startPath: String): File? {
        var current: File? = File(startPath).absoluteFile
        while (current != null) {
            val candidate = File(current, CONFIG_FILE_NAME)
            if (candidate.exists()) {
                return candidate
            }
            current = current.parentFile
        }
        return null
    }

    fun cleanupConfigBackups(configFile: File): List<String> {
        val parent = configFile.parentFile ?: return emptyList()
        val prefix = "${configFile.name}.bak."
        val removed = mutableListOf<String>()
        val backups = parent.listFiles { file -> file.isFile && file.name.startsWith(prefix) } ?: return emptyList()
        for (backup in backups) {
            if (backup.delete()) {
                removed.add(backup.name)
            }
        }
        return removed
    }

    fun selfPeerConfigChanged(previous: PeerEntry?, current: PeerEntry): Boolean {
        if (previous == null) {
            return false
        }
        return snapshotSelfPeerForRestart(previous) != snapshotSelfPeerForRestart(current)
    }

    fun ensureConfig(
        workspaceRoot: String?,
        editorKind: EditorKind,
        explicitPeerId: String?,
        solutionName: String?,
    ): EnsureConfigResult {
        if (workspaceRoot == null) {
            return EnsureConfigResult(
                status = EnsureConfigStatus.SKIPPED,
                changes = listOf("No workspace folder is open."),
            )
        }

        val existingFile = findConfigFile(workspaceRoot)
        return if (existingFile != null) {
            ensureSelfInConfig(existingFile, editorKind, workspaceRoot, explicitPeerId, solutionName)
        } else {
            createInitialConfig(workspaceRoot, editorKind, explicitPeerId, solutionName)
        }
    }

    private fun parseRawBridgeConfig(content: String): ParseBridgeConfigResult {
        val data = try {
            mapper.readTree(content)
        } catch (error: Exception) {
            val message = error.message ?: error.toString()
            return ParseBridgeConfigResult.Fail("JSON parse error: $message")
        }

        if (!data.isObject) {
            return ParseBridgeConfigResult.Fail("Root value is not a JSON object.")
        }

        val salvaged = salvageRawBridgeConfig(data)
        if (salvaged.raw == null) {
            return ParseBridgeConfigResult.Fail(salvaged.warnings.joinToString(" "))
        }

        return ParseBridgeConfigResult.Ok(ParsedBridgeConfig(salvaged.raw, salvaged.warnings))
    }

    fun loadBridgeConfig(configFile: File, editorKind: EditorKind, solutionName: String?): BridgeConfig {
        val parsed = parseRawBridgeConfig(configFile.readText())
        val raw = when (parsed) {
            is ParseBridgeConfigResult.Fail -> throw IllegalStateException("Invalid $CONFIG_FILE_NAME: ${parsed.error}")
            is ParseBridgeConfigResult.Ok -> parsed.parsed.raw
        }
        return resolveBridgeConfig(raw, editorKind, solutionName)
    }

    fun findAvailablePort(usedPorts: Set<Int>): Int {
        for (port in PORT_RANGE_START..PORT_RANGE_END) {
            if (port in usedPorts) {
                continue
            }
            try {
                ServerSocket(port, 1, java.net.InetAddress.getByName("127.0.0.1")).use { return port }
            } catch (_: Exception) {
                // port in use
            }
        }
        throw IllegalStateException("No available port found in range $PORT_RANGE_START-$PORT_RANGE_END")
    }

    private fun ensureSelfInConfig(
        configFile: File,
        editorKind: EditorKind,
        workspaceRoot: String,
        explicitPeerId: String?,
        solutionName: String?,
    ): EnsureConfigResult {
        val changes = mutableListOf<String>()
        val projectType = solutionName ?: "all"

        val content = try {
            configFile.readText()
        } catch (error: Exception) {
            val message = error.message ?: error.toString()
            return EnsureConfigResult(
                status = EnsureConfigStatus.SKIPPED,
                changes = listOf("Failed to read config: $message"),
            )
        }

        val parsed = parseRawBridgeConfig(content)
        if (parsed is ParseBridgeConfigResult.Fail) {
            changes.add("Config repair: ${parsed.error}")
            return createInitialConfigAt(configFile, workspaceRoot, editorKind, explicitPeerId, solutionName, changes)
        }

        val parsedConfig = (parsed as ParseBridgeConfigResult.Ok).parsed
        var raw = parsedConfig.raw
        for (warning in parsedConfig.warnings) {
            changes.add(warning)
        }

        val peers = raw.peers.toMutableMap()
        normalizePeerWorkspaceRoots(peers.values.toList(), changes).forEach { (peerId, peer) ->
            peers[peerId] = peer
        }

        var self = findSelfPeer(peers.values.toList(), editorKind, explicitPeerId, projectType)
        if (self != null && validatePeerEntry(self) == null) {
            changes.add("Removed invalid self peer ${self.peerId}; will recreate or repair.")
            peers.remove(self.peerId)
            self = null
        }

        val storedWorkspaceRoot = normalizeStoredPath(workspaceRoot)

        if (self == null) {
            val entries = peers.values.toList()
            val usedPorts = entries.map { it.port }.toSet()
            val port = findAvailablePort(usedPorts)
            val peerId = explicitPeerId ?: generatePeerId(editorKind, entries)
            val instanceName = if (solutionName != null) {
                "${capitalize(editorKind.name)} ($solutionName)"
            } else {
                generateInstanceName(editorKind, entries)
            }

            val newPeer = PeerEntry(
                peerId = peerId,
                editorKind = editorKind,
                instanceName = instanceName,
                port = port,
                workspaceRoots = listOf(storedWorkspaceRoot),
                supportedProjectTypes = listOf(projectType),
                projectType = projectType,
            )

            peers[peerId] = newPeer
            changes.add("Added peer $peerId.")
            raw = ensureProjectType(raw.copy(peers = peers), projectType, changes)
            changes.addAll(writeConfig(configFile, raw))
            return EnsureConfigResult(
                status = EnsureConfigStatus.UPDATED,
                configPath = configFile.absolutePath,
                peerId = peerId,
                changes = changes,
            )
        }

        var selfChanged = false
        var updatedSelf = self

        if (!containsWorkspaceRoot(updatedSelf.workspaceRoots, storedWorkspaceRoot)) {
            updatedSelf = updatedSelf.copy(workspaceRoots = updatedSelf.workspaceRoots + storedWorkspaceRoot)
            changes.add("Added workspace root $storedWorkspaceRoot.")
            selfChanged = true
        }

        if (!updatedSelf.supportedProjectTypes.contains(projectType)) {
            updatedSelf = updatedSelf.copy(supportedProjectTypes = updatedSelf.supportedProjectTypes + projectType)
            changes.add("Added supported project type $projectType.")
            selfChanged = true
        }

        if (updatedSelf.projectType != projectType) {
            updatedSelf = updatedSelf.copy(projectType = projectType)
            changes.add("Updated project type to $projectType.")
            selfChanged = true
        }

        if (selfChanged) {
            peers[updatedSelf.peerId] = updatedSelf
        }

        raw = ensureProjectType(raw.copy(peers = peers), projectType, changes)

        if (changes.isNotEmpty()) {
            changes.addAll(writeConfig(configFile, raw))
            return EnsureConfigResult(
                status = EnsureConfigStatus.UPDATED,
                configPath = configFile.absolutePath,
                peerId = updatedSelf.peerId,
                changes = changes,
            )
        }

        // Still scrub leftover backups even when the config itself is current.
        val removedBackups = cleanupConfigBackups(configFile)
        if (removedBackups.isNotEmpty()) {
            changes.add("Removed ${removedBackups.size} config backup file(s).")
            return EnsureConfigResult(
                status = EnsureConfigStatus.UPDATED,
                configPath = configFile.absolutePath,
                peerId = updatedSelf.peerId,
                changes = changes,
            )
        }

        return EnsureConfigResult(
            status = EnsureConfigStatus.UNCHANGED,
            configPath = configFile.absolutePath,
            peerId = updatedSelf.peerId,
            changes = changes,
        )
    }

    private fun createInitialConfig(
        workspaceRoot: String,
        editorKind: EditorKind,
        explicitPeerId: String?,
        solutionName: String?,
    ): EnsureConfigResult {
        val configFile = File(workspaceRoot, CONFIG_FILE_NAME)
        return createInitialConfigAt(configFile, workspaceRoot, editorKind, explicitPeerId, solutionName, emptyList())
    }

    private fun createInitialConfigAt(
        configFile: File,
        workspaceRoot: String,
        editorKind: EditorKind,
        explicitPeerId: String?,
        solutionName: String?,
        priorChanges: List<String>,
    ): EnsureConfigResult {
        val port = findAvailablePort(emptySet())
        val projectType = solutionName ?: "all"
        val peerId = explicitPeerId ?: "${editorKind.name}-01"
        val instanceName = if (solutionName != null) {
            "${capitalize(editorKind.name)} ($solutionName)"
        } else {
            "${capitalize(editorKind.name)} 01"
        }

        val typeHierarchy = if (projectType != "all") {
            mapOf("all" to listOf(projectType), projectType to emptyList())
        } else {
            mapOf("all" to emptyList())
        }

        val config = RawBridgeConfig(
            peers = mapOf(
                peerId to PeerEntry(
                    peerId = peerId,
                    editorKind = editorKind,
                    instanceName = instanceName,
                    port = port,
                    workspaceRoots = listOf(normalizeStoredPath(workspaceRoot)),
                    supportedProjectTypes = listOf(projectType),
                    projectType = projectType,
                ),
            ),
            typeHierarchy = typeHierarchy,
            routing = RoutingConfig(requestTimeoutMs = 3000),
            ui = UiConfig(statusBar = true, focusOnJump = false),
        )

        val writeChanges = writeConfig(configFile, config)
        return EnsureConfigResult(
            status = EnsureConfigStatus.CREATED,
            configPath = configFile.absolutePath,
            peerId = peerId,
            changes = priorChanges + "Created config with peer $peerId." + writeChanges,
        )
    }

    private fun resolveBridgeConfig(raw: RawBridgeConfig, myEditorKind: EditorKind, solutionName: String?): BridgeConfig {
        val entries = raw.peers.values.toList()
        val explicitPeerId = System.getProperty("editor.peer.bridge.peerId")

        val self = when {
            explicitPeerId != null -> entries.firstOrNull { it.peerId == explicitPeerId }
                ?: throw IllegalStateException("No peer entry found for peerId '$explicitPeerId' in $CONFIG_FILE_NAME")
            solutionName != null -> entries.firstOrNull { it.editorKind == myEditorKind && it.projectType == solutionName }
                ?: entries.firstOrNull { it.editorKind == myEditorKind }
                ?: throw IllegalStateException("No peer entry found for editorKind '$myEditorKind' in $CONFIG_FILE_NAME")
            else -> entries.firstOrNull { it.editorKind == myEditorKind }
                ?: throw IllegalStateException("No peer entry found for editorKind '$myEditorKind' in $CONFIG_FILE_NAME")
        }

        return BridgeConfig(
            self = self,
            knownPeers = entries.filter { it.peerId != self.peerId },
            typeHierarchy = raw.typeHierarchy,
            routing = raw.routing,
            ui = raw.ui,
        )
    }

    private data class SalvageResult(val raw: RawBridgeConfig?, val warnings: List<String>)

    private fun salvageRawBridgeConfig(data: JsonNode): SalvageResult {
        val warnings = mutableListOf<String>()
        val peers = mutableMapOf<String, PeerEntry>()

        val peersNode = data.path("peers")
        if (peersNode.isObject) {
            peersNode.fields().forEach { (key, value) ->
                val peer = validatePeerEntry(value)
                if (peer != null) {
                    val peerId = peer.peerId.ifBlank { key }
                    peers[peerId] = peer.copy(peerId = peerId)
                } else {
                    warnings.add("Dropped invalid peer entry \"$key\".")
                }
            }
        } else {
            warnings.add("Missing or invalid peers object.")
        }

        val typeHierarchy = mutableMapOf("all" to emptyList<String>())
        val hierarchyNode = data.path("typeHierarchy")
        if (hierarchyNode.isObject) {
            hierarchyNode.fields().forEach { (key, value) ->
                if (value.isArray && value.all { it.isTextual }) {
                    typeHierarchy[key] = value.map { it.asText() }
                } else {
                    warnings.add("Dropped invalid typeHierarchy entry \"$key\".")
                }
            }
        } else {
            warnings.add("Missing or invalid typeHierarchy; using defaults.")
        }

        if (!typeHierarchy.containsKey("all")) {
            typeHierarchy["all"] = emptyList()
        }

        val routing = if (data.path("routing").isObject) {
            val timeout = data.path("routing").path("requestTimeoutMs")
            RoutingConfig(
                requestTimeoutMs = if (timeout.isNumber) timeout.asLong() else 3000,
            )
        } else {
            null
        }

        val ui = if (data.path("ui").isObject) {
            val uiNode = data.path("ui")
            UiConfig(
                statusBar = if (uiNode.path("statusBar").isBoolean) uiNode.path("statusBar").asBoolean() else null,
                focusOnJump = if (uiNode.path("focusOnJump").isBoolean) uiNode.path("focusOnJump").asBoolean() else null,
            )
        } else {
            null
        }

        return SalvageResult(
            RawBridgeConfig(
                peers = peers,
                typeHierarchy = typeHierarchy,
                routing = routing,
                ui = ui,
            ),
            warnings,
        )
    }

    private fun validatePeerEntry(value: JsonNode): PeerEntry? {
        if (!value.isObject) {
            return null
        }

        val peerId = value.path("peerId").takeIf { it.isTextual }?.asText()?.trim().orEmpty()
        if (peerId.isEmpty()) {
            return null
        }

        val editorKind = parseEditorKind(value.path("editorKind").asText(null)) ?: return null
        val instanceName = value.path("instanceName").takeIf { it.isTextual }?.asText()?.trim().orEmpty()
        if (instanceName.isEmpty()) {
            return null
        }

        val port = value.path("port")
        if (!port.isInt || port.asInt() !in PORT_RANGE_START..PORT_RANGE_END) {
            return null
        }

        val workspaceRootsNode = value.path("workspaceRoots")
        if (!workspaceRootsNode.isArray || workspaceRootsNode.any { !it.isTextual }) {
            return null
        }

        val supportedTypesNode = value.path("supportedProjectTypes")
        if (!supportedTypesNode.isArray || supportedTypesNode.any { !it.isTextual }) {
            return null
        }

        val projectType = value.path("projectType").takeIf { it.isTextual }?.asText()?.trim().orEmpty()
        if (projectType.isEmpty()) {
            return null
        }

        return PeerEntry(
            peerId = peerId,
            editorKind = editorKind,
            instanceName = instanceName,
            port = port.asInt(),
            workspaceRoots = workspaceRootsNode.map { it.asText() },
            supportedProjectTypes = supportedTypesNode.map { it.asText() },
            projectType = projectType,
        )
    }

    private fun validatePeerEntry(peer: PeerEntry): PeerEntry? {
        if (peer.peerId.isBlank() || peer.instanceName.isBlank() || peer.projectType.isBlank()) {
            return null
        }
        if (peer.port !in PORT_RANGE_START..PORT_RANGE_END) {
            return null
        }
        if (peer.workspaceRoots.isEmpty() || peer.supportedProjectTypes.isEmpty()) {
            return null
        }
        return peer
    }

    private fun parseEditorKind(value: String?): EditorKind? {
        if (value.isNullOrBlank()) {
            return null
        }
        return try {
            EditorKind.valueOf(value)
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    private fun findSelfPeer(
        entries: List<PeerEntry>,
        editorKind: EditorKind,
        explicitPeerId: String?,
        projectType: String,
    ): PeerEntry? {
        if (explicitPeerId != null) {
            return entries.firstOrNull { it.peerId == explicitPeerId }
        }

        return entries.firstOrNull { it.editorKind == editorKind && it.projectType == projectType }
            ?: entries.firstOrNull { it.editorKind == editorKind }
    }

    private fun ensureProjectType(raw: RawBridgeConfig, projectType: String, changes: MutableList<String>): RawBridgeConfig {
        val hierarchy = raw.typeHierarchy.toMutableMap()
        if (!hierarchy.containsKey("all")) {
            hierarchy["all"] = emptyList()
            changes.add("Created type hierarchy.")
        }

        if (projectType != "all" && !hierarchy.containsKey(projectType)) {
            hierarchy[projectType] = emptyList()
            changes.add("Added type hierarchy entry $projectType.")
        }

        if (projectType != "all") {
            val allChildren = hierarchy["all"]?.toMutableList() ?: mutableListOf()
            if (!allChildren.contains(projectType)) {
                allChildren.add(projectType)
                hierarchy["all"] = allChildren
                changes.add("Linked $projectType under all.")
            }
        }

        return raw.copy(typeHierarchy = hierarchy)
    }

    private fun normalizePeerWorkspaceRoots(entries: List<PeerEntry>, changes: MutableList<String>): Map<String, PeerEntry> {
        return entries.associate { peer ->
            val normalized = normalizeWorkspaceRoots(peer.workspaceRoots)
            if (normalized.changed) {
                changes.add("Normalized workspace roots for ${peer.peerId}.")
                peer.peerId to peer.copy(workspaceRoots = normalized.roots)
            } else {
                peer.peerId to peer
            }
        }
    }

    private data class NormalizedRoots(val roots: List<String>, val changed: Boolean)

    private fun normalizeWorkspaceRoots(roots: List<String>): NormalizedRoots {
        val result = mutableListOf<String>()
        val seen = mutableSetOf<String>()
        var changed = false

        for (root in roots) {
            val storedRoot = normalizeStoredPath(root)
            val key = normalizePath(storedRoot)
            if (!seen.add(key)) {
                changed = true
                continue
            }

            result.add(storedRoot)
            changed = changed || storedRoot != root
        }

        return NormalizedRoots(result, changed)
    }

    private fun containsWorkspaceRoot(roots: List<String>, root: String): Boolean {
        val key = normalizePath(root)
        return roots.any { normalizePath(it) == key }
    }

    private fun generatePeerId(editorKind: EditorKind, existingPeers: List<PeerEntry>): String {
        val samePeers = existingPeers.filter { it.editorKind == editorKind }
        val num = (samePeers.size + 1).toString().padStart(2, '0')
        return "${editorKind.name}-$num"
    }

    private fun generateInstanceName(editorKind: EditorKind, existingPeers: List<PeerEntry>): String {
        val samePeers = existingPeers.filter { it.editorKind == editorKind }
        val num = (samePeers.size + 1).toString().padStart(2, '0')
        return "${capitalize(editorKind.name)} $num"
    }

    private fun capitalize(value: String): String {
        if (value.isEmpty()) {
            return value
        }
        return value.replaceFirstChar { it.uppercase() }
    }

    private fun snapshotSelfPeerForRestart(peer: PeerEntry): String {
        return mapper.writeValueAsString(
            mapOf(
                "peerId" to peer.peerId,
                "port" to peer.port,
            ),
        )
    }

    private fun snapshotSelfPeer(peer: PeerEntry): String {
        return mapper.writeValueAsString(
            mapOf(
                "peerId" to peer.peerId,
                "editorKind" to peer.editorKind.name,
                "instanceName" to peer.instanceName,
                "port" to peer.port,
                "workspaceRoots" to peer.workspaceRoots.sorted(),
                "supportedProjectTypes" to peer.supportedProjectTypes.sorted(),
                "projectType" to peer.projectType,
            ),
        )
    }

    private fun writeConfig(configFile: File, config: RawBridgeConfig): List<String> {
        configFile.writeText(mapper.writerWithDefaultPrettyPrinter().writeValueAsString(config) + "\n")
        val removedBackups = cleanupConfigBackups(configFile)
        return if (removedBackups.isEmpty()) {
            emptyList()
        } else {
            listOf("Removed ${removedBackups.size} config backup file(s).")
        }
    }
}
