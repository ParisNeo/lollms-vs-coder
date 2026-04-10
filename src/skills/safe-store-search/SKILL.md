---
name: safe-store-search
description: >
  No description provided.
author: Lollms User
version: 1.0.0
category: general
created: 2026-04-09
---

## Search & Query Patterns

### 1. Basic Similarity Search
```python
from safe_store import SafeStore

store = SafeStore("searchable.db")

with store:
    # Simple query
    results = store.query("programming languages", top_k=2)
    for r in results:
        print(f"Score: {r['similarity_percent']:.1f}%")
        print(f"Text: {r['chunk_text'][:100]}...")
```

### 2. Similarity Threshold Filtering
```python
with store:
    # Only return results above 70% similarity
    results = store.query(
        "machine learning applications",
        top_k=10,
        min_similarity_percent=70.0
    )
```

### 3. Reconstruct Original Documents
```python
with store:
    # Get full original text from chunks
    full_text = store.reconstruct_document_text("path/to/document.pdf")
    print(f"Reconstructed length: {len(full_text)} chars")
```
