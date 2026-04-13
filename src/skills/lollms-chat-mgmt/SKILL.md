---
name: lollms-chat-mgmt
description: >
  No description provided.
author: ParisNeo
version: 1.0.0
category: lollms
created: 2026-04-09
---

# Discussion Management

## Persistent Chat
```python
from lollms_client import LollmsDiscussion, LollmsDataManager

db = LollmsDataManager("sqlite:///my_chat.db")
discussion = LollmsDiscussion.create_new(lc, db_manager=db)

discussion.chat("My name is Alice.")
discussion.memorize() # Extracts facts to long-term memory
```

## Context Zones
Manipulate what the AI sees:
```python
discussion.user_data_zone = "User Level: Expert"
discussion.system_prompt = "You are a Linux terminal."

status = discussion.get_context_status()
print(status['current_tokens'])
```
