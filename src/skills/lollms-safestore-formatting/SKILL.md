---
name: lollms-safestore-formatting
description: >
  Guidelines for formatting SafeStore chunks for LollmsClient to ensure accurate source attribution.
author: ParisNeo
version: 1.0.0
category: ai/knowledge_management/rag
created: 2026-04-09
---

# 💎 SOURCE OF TRUTH: RAG Context Formatting Protocol

When injecting `safe_store` results into a `LollmsClient` prompt, use this specific structure to prevent the AI from confusing different sources.

## 🧱 The "Chunk Block" Format
Always wrap each chunk in clear visual delimiters:

```text
[SOURCE ID: {idx}]
FILE: {file_path}
METADATA: {json_metadata}
CONTENT: 
{chunk_text}
--------------------------
```

## 📜 System Instruction Enforcement
Include this instruction in your system prompt to force the AI to use the data correctly:

```text
### CITATION RULES:
1. You have been provided with several context chunks.
2. Every claim you make MUST be followed by a citation in brackets, e.g., [SOURCE 1].
3. If information contradicts your internal knowledge, prioritize the provided context.
4. Do not mention "The provided text states..."; simply answer the question and cite.
```

## 🚀 Optimization: Context Re-Ranking
If `top_k` is large, use the LLM to filter results before the final generation:

```python
def filter_chunks(question, chunks):
    # Ask LLM to pick indices of relevant chunks first
    # This reduces noise and saves tokens for the final generation
    pass 
```
