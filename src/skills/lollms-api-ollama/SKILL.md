---
name: lollms-api-ollama
description: >
  No description provided.
author: Lollms User
version: 1.0.0
category: general
created: 2026-04-09
---

# 🟠 Service 2: Ollama Compatible API
**Base URL Path:** `/ollama/v1`

This service provides an interface compatible with the Ollama API structure, ideal for tools specifically looking for Ollama endpoints or using the Ollama SDK.

### Endpoints:
*   **`GET /ollama/v1/models`**: Returns active models in the Ollama JSON format.
*   **`POST /ollama/v1/chat/completions`**: Standard chat interface. Requests are internally routed through the LoLLMs generation engine.
