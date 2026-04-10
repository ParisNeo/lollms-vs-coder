---
name: safe-store-debugging
description: >
  No description provided.
author: Lollms User
version: 1.0.0
category: general
created: 2026-04-09
---

## Error Handling & Debugging

### 1. Health Checks
```python
def health_check(store):
    with store:
        cursor = store.conn.cursor()
        docs = cursor.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
        integrity = cursor.execute("PRAGMA integrity_check").fetchone()[0]
        return {"documents": docs, "status": integrity}
```

### 2. Vector Inspection
```python
import numpy as np
with store:
    cursor = store.conn.execute("SELECT vector_data FROM vectors LIMIT 1")
    blob = cursor.fetchone()[0]
    vec = np.frombuffer(blob, dtype=np.float32)
    print(f"Vector Shape: {vec.shape}")
```
