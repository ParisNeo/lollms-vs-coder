---
name: coding-documentation
description: >
  No description provided.
author: ParisNeo
version: 1.0.0
category: general
created: 2026-04-09
---

# Professional Documentation Standards

## Self-Documenting Code
- **Intent-based Naming**: Variable and function names should explain *what* they do.
- **Small Functions**: Break complex logic into small, named units that read like prose.
- **Avoid Obvious Comments**: Don't comment code that is already clear. Use comments to explain the "Why" (business logic, workarounds), not the "How".

## API & Technical Docs
- **OpenAPI/Swagger**: Always define external API schemas using standard specs.
- **Docstrings**: Use standard formats (Google, JSDoc, Sphinx) for public-facing libraries.
- **Type Hints**: Use TypeScript or Python Type Hints to make code behavior predictable without reading docs.

## README Standards
1. **The Hook**: Clear title and one-sentence value proposition.
2. **Prerequisites**: Exact versions of runtimes/tools needed.
3. **Quick Start**: Minimal steps to get the project running.
4. **Architecture**: High-level overview of how components interact.
