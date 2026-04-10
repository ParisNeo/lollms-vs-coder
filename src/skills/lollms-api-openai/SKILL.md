---
name: lollms-api-openai
description: >
  No description provided.
author: Lollms User
version: 1.0.0
category: general
created: 2026-04-09
---

# 🟢 Service 1: OpenAI Compatible API
**Base URL Path:** `/v1`

LoLLMs implements the standard OpenAI V1 specification, allowing it to function as a drop-in replacement for any tool supporting OpenAI (AutoGPT, LangChain, etc.).

### Endpoints:
*   **`GET /v1/models`**: Lists all available models across active LLM bindings.
*   **`POST /v1/chat/completions`**: Standard chat completion endpoint. Supports streaming, tool calls (function calling), and vision.
*   **`POST /v1/embeddings`**: Generates vector embeddings for input strings.
*   **`POST /v1/images/generations`**: Generates images using the platform's active Text-to-Image (TTI) engine.
