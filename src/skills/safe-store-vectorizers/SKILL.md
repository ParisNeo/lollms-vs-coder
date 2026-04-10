---
name: safe-store-vectorizers
description: >
  Specific configurations for different embedding backends (Ollama, OpenAI, ST).
author: Lollms User
version: 1.0.0
category: ai/knowledge_management/safe_store
created: 2026-04-09
---

# 💎 SOURCE OF TRUTH: Vectorizer Configurations

## 1. Ollama (Local)
```python
vectorizer_name="ollama"
vectorizer_config={
    "model": "nomic-embed-text",
    "host": "http://localhost:11434"
}
```

## 2. Sentence Transformers (Local)
```python
vectorizer_name="st"
vectorizer_config={
    "model": "all-MiniLM-L6-v2" # or "LaBSE" for multilingual
}
```

## 3. OpenAI (Cloud)
```python
vectorizer_name="openai"
vectorizer_config={
    "model": "text-embedding-3-small",
    "api_key": "sk-..."
}
```

## 4. TF-IDF (Classic/Fast)
```python
vectorizer_name="tf_idf"
vectorizer_config={
    "name": "my_search_index"
}
```
