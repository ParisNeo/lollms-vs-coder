---
name: lollms-image-gen
description: >
  No description provided.
author: Lollms User
version: 1.0.0
category: general
created: 2026-04-09
---

# Multimodal Operations

## Text-to-Image
Requires a TTI binding (e.g., `diffusers`).

```python
lc = LollmsClient(tti_binding_name="diffusers", ...)

img_bytes = lc.generate_image(
    prompt="Cyberpunk city",
    width=1024,
    height=1024
)
```

## Vision (Chat)
Send images to a vision model.

```python
discussion.add_message(
    sender="user",
    content="What is this?",
    images=[base64_image_string]
)
response = discussion.chat()
```
