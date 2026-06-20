package com.editorpeerbridge

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

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
}
