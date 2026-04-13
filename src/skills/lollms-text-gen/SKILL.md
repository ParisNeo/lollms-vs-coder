---
name: lollms-text-gen
description: >
  No description provided.
author: ParisNeo
version: 1.0.0
category: general
created: 2026-04-09
---

# Text Generation

## Basic Generation
```python
from lollms_client import LollmsClient
lc = LollmsClient(...)

response = lc.generate_text(
    prompt="Why is the sky blue?",
    n_predict=512,
    temperature=0.7
)
print(response)
```

## Streaming
```python
from lollms_client import MSG_TYPE

def callback(chunk, type, **kwargs):
    if type == MSG_TYPE.MSG_TYPE_CHUNK:
        print(chunk, end="", flush=True)
    return True

lc.generate_text(
    prompt="Tell me a story",
    stream=True,
    streaming_callback=callback
)
```

## Chat Generation (Messages)
```python
messages = [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
]
response = lc.generate_from_messages(messages)
```
