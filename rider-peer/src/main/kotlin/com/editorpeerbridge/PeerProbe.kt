package com.editorpeerbridge

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.Callable
import java.util.concurrent.Executors

object PeerProbe {
    private val mapper = jacksonObjectMapper()
    private val client: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofMillis(500))
        .build()

    fun probePeerServer(port: Int, expectedPeerId: String): Boolean {
        return try {
            val request = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:$port/peer/v1/info"))
                .timeout(Duration.ofMillis(500))
                .GET()
                .build()

            val response = client.send(request, HttpResponse.BodyHandlers.ofString())
            if (response.statusCode() != 200) {
                return false
            }

            val body = mapper.readTree(response.body())
            body.path("ok").asBoolean(false) &&
                body.path("data").path("identity").path("peerId").asText() == expectedPeerId
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Locate the port [peer] actually listens on.
     *
     * Ports are assigned per workspace config, but the range is shared
     * machine-wide: a peer whose configured port was taken falls back to another
     * one for the session without rewriting the config. Sending to the configured
     * port would then reach an unrelated peer, which answers with a confusing
     * mismatch error, so verify the identity first and search the range when it
     * does not match. Returns null when nothing identifies as this peer.
     */
    fun resolvePeerPort(peer: PeerEntry): Int? {
        if (probePeerServer(peer.port, peer.peerId)) {
            return peer.port
        }

        val candidates = (BridgeConfigSupport.PORT_RANGE_START..BridgeConfigSupport.PORT_RANGE_END)
            .filter { it != peer.port }
        val pool = Executors.newFixedThreadPool(minOf(16, candidates.size))
        return try {
            pool.invokeAll(candidates.map { port -> Callable { if (probePeerServer(port, peer.peerId)) port else null } })
                .mapNotNull { future -> runCatching { future.get() }.getOrNull() }
                .minOrNull()
        } catch (_: Exception) {
            null
        } finally {
            pool.shutdownNow()
        }
    }
}
