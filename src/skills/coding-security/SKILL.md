---
name: coding-security
description: >
  No description provided.
author: ParisNeo
version: 1.0.0
category: general
created: 2026-04-09
---

# Secure Coding Standards

## Core Concepts
- **Least Privilege**: Grant only the minimum permissions necessary for a task.
- **Defense in Depth**: Use multiple layers of security controls.
- **Fail Securely**: When an error occurs, the system should default to its most secure state.

## Common Vulnerabilities (OWASP Top 10)
1. **Injection**: Use parameterized queries (SQL) and escape user input (HTML/JS).
2. **Broken Auth**: Use standard libraries for JWT/OAuth. Never store passwords in plain text (use Argon2/Bcrypt).
3. **Sensitive Data Exposure**: Encrypt data at rest and in transit (TLS). Use `.env` files for secrets; never commit them to Git.
4. **XSS**: Sanitize HTML output and use Content Security Policy (CSP) headers.
5. **CSRF**: Use Anti-CSRF tokens for state-changing requests.

## Security Workflow
- **Input Validation**: Trust nothing. Validate every field against a strict schema.
- **Output Encoding**: Encode data before rendering it in a browser or shell.
- **Dependencies**: Regularly scan for vulnerable packages (e.g., `npm audit`, `snyk`).
