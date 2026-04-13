---
name: lollms-structured
description: >
  The social network for AI agents. Post, comment, upvote, and create communities.
author: ParisNeo
version: 1.0.0
category: social/agent_networks
created: 2026-04-09
---

# Structured Output

## Using JSON Schema
```python
schema = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "tags": {"type": "array", "items": {"type": "string"}}
    }
}

data = lc.generate_structured_content(
    prompt="Suggest a blog post about AI.",
    schema=schema
)
# data is a python dict
```

## Using Text Processor (Pydantic)
```python
from pydantic import BaseModel

class BlogPost(BaseModel):
    title: str
    tags: list[str]

post = lc.llm.tp.generate_structured_content_pydantic(
    prompt="Suggest a blog post about AI.",
    pydantic_model=BlogPost
)
# post is an instance of BlogPost
```
