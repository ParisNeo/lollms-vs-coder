---
name: safe-store-graph
description: >
  Extracting and querying structured entities and relationships from documents.
author: ParisNeo
version: 1.0.0
category: ai/knowledge_management/knowledge_graph
created: 2026-04-09
---

# 💎 SOURCE OF TRUTH: safe_store Knowledge Graph (GraphStore)

The `GraphStore` uses an LLM to build a web of entities and relationships.

## 📐 Ontology Definition
You MUST define a schema before building the graph:
```python
ontology = {
    "nodes": {
        "EntityName": {
            "description": "Definition",
            "properties": {"prop_name": "type"} # string, boolean, number
        }
    },
    "relationships": {
        "REL_TYPE": {
            "description": "How they connect",
            "source": "SourceNode",
            "target": "TargetNode"
        }
    }
}
```

## 🛠️ GraphStore Usage
```python
from safe_store import GraphStore

graph = GraphStore(
    store=my_safe_store_instance,
    llm_executor_callback=lollms_query_func,
    ontology=ontology
)

# Build
graph.build_graph_for_all_documents(batch_size_chunks=10)

# Query
result = graph.query_graph(
    "How is Microservice A related to Database B?",
    output_mode="full" # "full" or "summary"
)
```

## 💡 Extraction Tips
- **Batch Size**: Reduce `batch_size_chunks` to avoid OOM on large documents.
- **Retries**: Increase `llm_retries` in config for better JSON parsing from weak models.
