---
name: lollms-artefacts-system-1772558834790
description: >
  Complete guide to creating, using, and managing artefacts in Lollms for structured content generation
author: Lollms User
version: 1.0.0
category: ai/lollms/features/artefacts
created: 2026-03-03
---

# Lollms Artefacts: Complete Documentation

## Overview

Artefacts in Lollms are structured, self-contained content blocks that represent generated outputs like code files, documents, images, or data structures. They provide a standardized way to handle multi-file outputs, enable persistent storage, and support rich metadata for tracking generation context.

## Core Concepts

### What is an Artefact?

An artefact is a named, typed container for generated content with the following properties:

| Property | Description |
|----------|-------------|
| `name` | Unique identifier for the artefact |
| `type` | Content category (code, document, image, data, etc.) |
| `content` | The actual generated data |
| `metadata` | Generation context, timestamps, model info |
| `version` | Tracking for iterative improvements |

### Artefact Types

```python
ARTEFACT_TYPES = {
    "code": {
        "extensions": [".py", ".js", ".ts", ".java", ".cpp", ".c", ".go", ".rs"],
        "mime_types": ["text/x-python", "application/javascript", "text/x-java"],
        "features": ["syntax_highlighting", "line_numbers", "execution"]
    },
    "document": {
        "extensions": [".md", ".txt", ".rst", ".html"],
        "mime_types": ["text/markdown", "text/plain", "text/html"],
        "features": ["rendering", "search", "export"]
    },
    "image": {
        "extensions": [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"],
        "mime_types": ["image/png", "image/jpeg", "image/svg+xml"],
        "features": ["thumbnail", "metadata_extraction", "transformations"]
    },
    "data": {
        "extensions": [".json", ".yaml", ".yml", ".csv", ".xml"],
        "mime_types": ["application/json", "application/yaml", "text/csv"],
        "features": ["validation", "schema_enforcement", "querying"]
    },
    "audio": {
        "extensions": [".wav", ".mp3", ".ogg", ".flac"],
        "mime_types": ["audio/wav", "audio/mpeg", "audio/ogg"],
        "features": ["playback", "waveform", "transcription"]
    },
    "video": {
        "extensions": [".mp4", ".webm", ".avi", ".mov"],
        "mime_types": ["video/mp4", "video/webm"],
        "features": ["playback", "thumbnail", "streaming"]
    }
}
```

## Creating Artefacts

### 1. Via LollmsTextProcessor (Programmatic)

The `LollmsTextProcessor` class provides methods for generating artefacts through structured prompts:

```python
from lollms_client import LollmsTextProcessor
from lollms_client.lollms_core import LollmsClient

# Initialize
client = LollmsClient()
processor = LollmsTextProcessor(client)

# Generate single code artefact
code_artefact = processor.generate_code(
    prompt="Create a FastAPI endpoint for user authentication",
    language="python",
    template="""
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()

# Your implementation here
"""
)

# Returns: str with extracted code content
print(code_artefact)
```

### 2. Multi-File Artefact Generation

For generating complete projects with multiple files:

```python
# Generate multiple code files (artefacts)
code_files = processor.generate_codes(
    prompt="""
Create a complete Python project structure for a task management API:
- main.py: FastAPI application entry point
- models.py: SQLAlchemy models
- schemas.py: Pydantic schemas
- crud.py: Database operations
- database.py: Database connection setup
""",
    system_prompt="You are an expert Python backend developer."
)

# Returns: List[dict] with file information
for file_info in code_files:
    print(f"File: {file_info['file_name']}")
    print(f"Language: {file_info['language']}")
    print(f"Complete: {file_info['is_complete']}")
    print(f"Content preview: {file_info['content'][:200]}...")
```

### 3. Structured Data Artefacts

Generate validated JSON/data artefacts:

```python
schema = {
    "type": "object",
    "properties": {
        "project_name": {"type": "string"},
        "version": {"type": "string"},
        "dependencies": {
            "type": "array",
            "items": {"type": "string"}
        },
        "config": {
            "type": "object",
            "properties": {
                "debug": {"type": "boolean"},
                "port": {"type": "integer"}
            }
        }
    },
    "required": ["project_name", "version"]
}

config_artefact = processor.generate_structured_content(
    prompt="Generate a project configuration for a web application",
    schema=schema
)

# Returns: Python dict matching the schema
print(config_artefact)
```

## Artefact Storage and Persistence

### File-Based Storage

```python
import json
from pathlib import Path
from datetime import datetime

class ArtefactStore:
    """Persistent storage for Lollms artefacts."""
    
    def __init__(self, base_path: str = "./artefacts"):
        self.base_path = Path(base_path)
        self.base_path.mkdir(parents=True, exist_ok=True)
        
        # Type-specific subdirectories
        for artefact_type in ["code", "document", "image", "data", "audio", "video"]:
            (self.base_path / artefact_type).mkdir(exist_ok=True)
    
    def save(self, artefact: dict, namespace: str = "default") -> Path:
        """
        Save an artefact to persistent storage.
        
        Args:
            artefact: Dict with 'name', 'type', 'content', 'metadata'
            namespace: Logical grouping (project name, session id, etc.)
        
        Returns:
            Path to saved artefact
        """
        timestamp = datetime.now().isoformat()
        safe_name = "".join(c for c in artefact['name'] if c.isalnum() or c in '._-')
        
        # Determine subdirectory
        artefact_type = artefact.get('type', 'document')
        type_dir = self.base_path / artefact_type / namespace
        type_dir.mkdir(parents=True, exist_ok=True)
        
        # Add metadata
        full_artefact = {
            **artefact,
            "saved_at": timestamp,
            "path": str(type_dir / safe_name)
        }
        
        # Save content based on type
        if artefact_type in ['code', 'document', 'data']:
            # Text-based: save as file + metadata sidecar
            content_path = type_dir / safe_name
            with open(content_path, 'w', encoding='utf-8') as f:
                f.write(artefact['content'])
            
            meta_path = type_dir / f"{safe_name}.meta.json"
            with open(meta_path, 'w') as f:
                json.dump({k: v for k, v in full_artefact.items() if k != 'content'}, f, indent=2)
                
        else:
            # Binary: save metadata separately, content as-is
            meta_path = type_dir / f"{safe_name}.meta.json"
            with open(meta_path, 'w') as f:
                json.dump(full_artefact, f, indent=2)
        
        return content_path if artefact_type in ['code', 'document', 'data'] else meta_path
    
    def load(self, name: str, artefact_type: str, namespace: str = "default") -> dict:
        """Load an artefact from storage."""
        type_dir = self.base_path / artefact_type / namespace
        
        # Try to find metadata
        meta_path = type_dir / f"{name}.meta.json"
        if meta_path.exists():
            with open(meta_path) as f:
                metadata = json.load(f)
            
            # Load content for text-based types
            if artefact_type in ['code', 'document', 'data']:
                content_path = type_dir / name
                with open(content_path, encoding='utf-8') as f:
                    metadata['content'] = f.read()
            
            return metadata
        
        raise FileNotFoundError(f"Artefact {name} not found in {namespace}/{artefact_type}")
    
    def list_artefacts(self, namespace: str = None, artefact_type: str = None) -> list:
        """List available artefacts with filtering."""
        artefacts = []
        
        types_to_search = [artefact_type] if artefact_type else ["code", "document", "image", "data"]
        
        for atype in types_to_search:
            type_path = self.base_path / atype
            if not type_path.exists():
                continue
                
            namespaces = [namespace] if namespace else [d.name for d in type_path.iterdir() if d.is_dir()]
            
            for ns in namespaces:
                ns_path = type_path / ns
                for meta_file in ns_path.glob("*.meta.json"):
                    with open(meta_file) as f:
                        info = json.load(f)
                        artefacts.append({
                            "name": info.get('name', meta_file.stem.replace('.meta', '')),
                            "type": atype,
                            "namespace": ns,
                            "saved_at": info.get('saved_at'),
                            "metadata": {k: v for k, v in info.items() if k not in ['content', 'saved_at']}
                        })
        
        return artefacts
```

### Database Storage (SQLite)

For complex applications requiring querying and relationships:

```python
import sqlite3
from contextlib import contextmanager

class ArtefactDatabase:
    """SQLite-backed artefact storage with full-text search."""
    
    SCHEMA = """
    CREATE TABLE IF NOT EXISTS artefacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        namespace TEXT DEFAULT 'default',
        content TEXT,
        content_hash TEXT UNIQUE,
        metadata_json TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE INDEX IF NOT EXISTS idx_type_ns ON artefacts(type, namespace);
    CREATE INDEX IF NOT EXISTS idx_name ON artefacts(name);
    
    -- Full-text search for code and documents
    CREATE VIRTUAL TABLE IF NOT EXISTS artefact_search USING fts5(
        name, content, content_rowid=rowid
    );
    
    CREATE TRIGGER IF NOT EXISTS artefacts_ai AFTER INSERT ON artefacts BEGIN
        INSERT INTO artefact_search(rowid, name, content)
        VALUES (new.id, new.name, new.content);
    END;
    
    CREATE TRIGGER IF NOT EXISTS artefacts_ad AFTER DELETE ON artefacts BEGIN
        INSERT INTO artefact_search(artefact_search, rowid, name, content)
        VALUES ('delete', old.id, old.name, old.content);
    END;
    """
    
    def __init__(self, db_path: str = "artefacts.db"):
        self.db_path = db_path
        self._init_db()
    
    def _init_db(self):
        with self._connect() as conn:
            conn.executescript(self.SCHEMA)
    
    @contextmanager
    def _connect(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()
    
    def save(self, artefact: dict, namespace: str = "default") -> int:
        """Save artefact and return its ID."""
        import hashlib
        
        content = artefact.get('content', '')
        content_hash = hashlib.sha256(content.encode()).hexdigest()[:16]
        
        with self._connect() as conn:
            cursor = conn.execute("""
                INSERT INTO artefacts (name, type, namespace, content, content_hash, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(content_hash) DO UPDATE SET
                    updated_at = CURRENT_TIMESTAMP,
                    metadata_json = excluded.metadata_json
                RETURNING id
            """, (
                artefact['name'],
                artefact.get('type', 'document'),
                namespace,
                content,
                content_hash,
                json.dumps(artefact.get('metadata', {}))
            ))
            return cursor.fetchone()['id']
    
    def search(self, query: str, artefact_type: str = None) -> list:
        """Full-text search across artefacts."""
        with self._connect() as conn:
            if artefact_type:
                rows = conn.execute("""
                    SELECT a.* FROM artefacts a
                    JOIN artefact_search s ON a.id = s.rowid
                    WHERE artefact_search MATCH ? AND a.type = ?
                    ORDER BY rank
                """, (query, artefact_type))
            else:
                rows = conn.execute("""
                    SELECT a.* FROM artefacts a
                    JOIN artefact_search s ON a.id = s.rowid
                    WHERE artefact_search MATCH ?
                    ORDER BY rank
                """, (query,))
            
            return [dict(row) for row in rows]
```

## Advanced Artefact Operations

### Code Editing with Artefacts

The `edit_code` method provides surgical precision for modifying existing code artefacts:

```python
# Load existing artefact
store = ArtefactStore()
existing = store.load("api_routes.py", "code", namespace="my_project")

# Apply targeted edits
edit_result = processor.edit_code(
    original_code=existing['content'],
    edit_instruction="""
    Add rate limiting to the /api/login endpoint:
    - Use slowapi library
    - Limit to 5 requests per minute per IP
    - Return 429 status when limit exceeded
    """,
    language="python",
    file_name="api_routes.py",
    max_chunk_size=100,  # Lines per analysis chunk
    context_lines=5,     # Context around changes
    fallback_to_full_rewrite=True  # Fallback if structured edit fails
)

if edit_result['success']:
    print(f"Applied {edit_result['edits_applied']} edit(s) via {edit_result['method']}")
    print(f"Summary: {edit_result.get('summary', 'N/A')}")
    
    # Save updated artefact
    store.save({
        'name': 'api_routes.py',
        'type': 'code',
        'content': edit_result['content'],
        'metadata': {
            'edit_history': existing.get('metadata', {}).get('edit_history', []) + [{
                'timestamp': datetime.now().isoformat(),
                'instruction': "Add rate limiting",
                'method': edit_result['method']
            }]
        }
    })
else:
    print(f"Edit failed: {edit_result['error']}")
```

### Artefact Versioning and Diff

```python
import difflib

class VersionedArtefact:
    """Track versions and compute diffs for artefacts."""
    
    def __init__(self, store: ArtefactStore, name: str, artefact_type: str, namespace: str):
        self.store = store
        self.name = name
        self.type = artefact_type
        self.namespace = namespace
        self.versions = []
    
    def commit(self, content: str, message: str, metadata: dict = None):
        """Save a new version with commit message."""
        version = {
            'timestamp': datetime.now().isoformat(),
            'message': message,
            'content_hash': hashlib.sha256(content.encode()).hexdigest()[:16],
            'metadata': metadata or {}
        }
        self.versions.append(version)
        
        # Save with version metadata
        return self.store.save({
            'name': self.name,
            'type': self.type,
            'content': content,
            'metadata': {
                'versions': self.versions,
                'latest_message': message
            }
        }, self.namespace)
    
    def diff(self, version_a: int = -2, version_b: int = -1) -> str:
        """Generate unified diff between two versions."""
        # Load both versions from storage
        # This is simplified - real implementation would track full history
        a_content = self._load_version(version_a)
        b_content = self._load_version(version_b)
        
        return '\n'.join(difflib.unified_diff(
            a_content.splitlines(keepends=True),
            b_content.splitlines(keepends=True),
            fromfile=f"{self.name}@{version_a}",
            tofile=f"{self.name}@{version_b}"
        ))
```

## Integration with Lollms Discussion System

Artefacts can be attached to discussion messages for rich conversation history:

```python
from lollms_client.lollms_discussion import Discussion, Message

class ArtefactMessage(Message):
    """Message with attached artefacts."""
    
    def __init__(self, *args, artefacts: list = None, **kwargs):
        super().__init__(*args, **kwargs)
        self.artefacts = artefacts or []
    
    def add_artefact(self, artefact: dict, inline: bool = False):
        """
        Attach an artefact to this message.
        
        Args:
            artefact: The artefact dict
            inline: If True, render content in message; if False, just reference
        """
        self.artefacts.append({
            **artefact,
            'inline': inline,
            'attached_at': datetime.now().isoformat()
        })
    
    def render(self) -> str:
        """Render message with artefact references."""
        base = self.content
        
        if self.artefacts:
            base += "\n\n---\n**Attached Artefacts:**\n"
            for art in self.artefacts:
                icon = self._get_icon(art['type'])
                if art.get('inline'):
                    preview = art['content'][:200].replace('\n', ' ')
                    base += f"\n{icon} **{art['name']}** (`{art['type']}`)\n```{art.get('language', 'text')}\n{preview}...\n```"
                else:
                    base += f"\n{icon} **{art['name']}** (`{art['type']}`) - {len(art.get('content', ''))} bytes"
        
        return base
    
    def _get_icon(self, artefact_type: str) -> str:
        icons = {
            'code': '💻', 'document': '📄', 'image': '🖼️',
            'data': '📊', 'audio': '🔊', 'video': '🎬'
        }
        return icons.get(artefact_type, '📦')
```

## Best Practices

### 1. Prompt Engineering for Reliable Artefacts

```python
# Good: Explicit, structured prompt
good_prompt = """
Create a Python module with the following specifications:

REQUIREMENTS:
- Implement a ThreadPoolExecutor wrapper with retry logic
- Include type hints throughout
- Add docstrings following Google style
- Include example usage in __main__ block

OUTPUT FORMAT:
Provide the complete implementation in a single code block.
"""

# Bad: Vague, open-ended prompt
bad_prompt = "Make a thread pool thing with retries"
```

### 2. Handling Large Artefacts

```python
# For artefacts exceeding context window, use chunking
large_code = processor.long_context_processing(
    text_to_process=very_large_source_file,
    contextual_prompt="Refactor this code to use async/await",
    processing_type="code",
    chunk_size_ratio=0.4,  # Conservative chunking
    overlap_ratio=0.15     # Higher overlap for code context
)
```

### 3. Validation and Testing

```python
def validate_code_artefact(code: str, language: str) -> dict:
    """Validate generated code artefacts."""
    import subprocess
    import tempfile
    
    results = {'valid': False, 'errors': [], 'warnings': []}
    
    if language == 'python':
        # Syntax check
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write(code)
            temp_path = f.name
        
        try:
            result = subprocess.run(
                ['python', '-m', 'py_compile', temp_path],
                capture_output=True, text=True
            )
            results['valid'] = result.returncode == 0
            if result.stderr:
                results['errors'].append(result.stderr)
        finally:
            Path(temp_path).unlink()
    
    # Additional checks: imports, undefined names, etc.
    # ...
    
    return results
```

## Complete Example: Project Scaffolding

```python
#!/usr/bin/env python3
"""
Complete example: Generate a full project structure using artefacts.
"""

from lollms_client import LollmsClient, LollmsTextProcessor
from lollms_client.lollms_discussion import Discussion
from pathlib import Path
import json

def scaffold_project(project_name: str, description: str, output_dir: str):
    """Generate a complete project scaffold with artefacts."""
    
    # Initialize
    client = LollmsClient()
    processor = LollmsTextProcessor(client)
    store = ArtefactStore(output_dir)
    
    # Phase 1: Generate project configuration
    print("🎯 Generating project configuration...")
    config = processor.generate_structured_content(
        prompt=f"""
        Create a project configuration for: {project_name}
        Description: {description}
        
        Include: dependencies, scripts, structure recommendations.
        """,
        schema={
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "version": {"type": "string"},
                "description": {"type": "string"},
                "dependencies": {"type": "array", "items": {"type": "string"}},
                "dev_dependencies": {"type": "array", "items": {"type": "string"}},
                "scripts": {"type": "object"},
                "structure": {
                    "type": "array",
                    "items": {"type": "string"}
                }
            },
            "required": ["name", "version", "dependencies"]
        }
    )
    
    # Save config artefact
    config_path = store.save({
        'name': 'project.json',
        'type': 'data',
        'content': json.dumps(config, indent=2),
        'metadata': {'phase': 'configuration'}
    }, namespace=project_name)
    print(f"  ✓ Config saved: {config_path}")
    
    # Phase 2: Generate core source files
    print("\n💻 Generating source files...")
    files_prompt = f"""
    Based on this project configuration:
    {json.dumps(config, indent=2)}
    
    Generate the main source files. For each file:
    - Include proper imports
    - Add comprehensive docstrings
    - Include type hints
    - Add basic error handling
    """
    
    source_files = processor.generate_codes(
        prompt=files_prompt,
        system_prompt="You are an expert Python developer focused on clean, maintainable code."
    )
    
    for file_info in source_files:
        path = store.save({
            'name': file_info['file_name'],
            'type': 'code',
            'content': file_info['content'],
            'metadata': {
                'language': file_info['language'],
                'generated_at': datetime.now().isoformat()
            }
        }, namespace=project_name)
        print(f"  ✓ {file_info['file_name']}: {path}")
    
    # Phase 3: Generate documentation
    print("\n📝 Generating documentation...")
    readme = processor.generate_code(
        prompt=f"""
        Create a comprehensive README.md for {project_name}.
        
        Include:
        - Installation instructions
        - Usage examples
        - API documentation
        - Contributing guidelines
        """,
        language="markdown"
    )
    
    readme_path = store.save({
        'name': 'README.md',
        'type': 'document',
        'content': readme,
        'metadata': {'phase': 'documentation'}
    }, namespace=project_name)
    print(f"  ✓ README: {readme_path}")
    
    # Phase 4: Generate tests
    print("\n🧪 Generating tests...")
    # ... similar pattern for test files
    
    print(f"\n🎉 Project scaffold complete in {output_dir}/{project_name}/")
    return store.list_artefacts(namespace=project_name)

# Run
if __name__ == "__main__":
    from datetime import datetime
    artefacts = scaffold_project(
        project_name="task-api",
        description="A RESTful API for task management with async support",
        output_dir="./generated_projects"
    )
    print(f"\nGenerated {len(artefacts)} artefacts")
```

## Summary

Artefacts in Lollms provide a powerful abstraction for managing generated content:

| Feature | Benefit |
|---------|---------|
| **Structured Generation** | XML-tag extraction ensures clean, parseable outputs |
| **Multi-file Support** | Generate complete projects in one operation |
| **Persistent Storage** | File-based or database backends for artefact lifecycle |
| **Version Control** | Track changes and compute diffs between versions |
| **Integration** | Seamless connection to discussions and workflows |

The `LollmsTextProcessor` class serves as the primary interface, with methods like `generate_code()`, `generate_codes()`, `generate_structured_content()`, and `edit_code()` providing comprehensive artefact manipulation capabilities.
