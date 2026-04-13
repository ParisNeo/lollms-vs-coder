---
name: coding-testing
description: >
  No description provided.
author: ParisNeo
version: 1.0.0
category: general
created: 2026-04-09
---

# Software Testing & Quality Assurance

## Testing Pyramid
- **Unit Tests**: Test individual functions/components in isolation. Fast and numerous.
- **Integration Tests**: Verify that different modules or services work together correctly.
- **E2E Tests**: Test the entire application flow from the user's perspective.

## Best Practices
1. **AAA Pattern**: Structure tests into **Arrange** (setup), **Act** (execute), and **Assert** (verify).
2. **Deterministic Tests**: Tests must be reliable. Mock external dependencies (APIs, Databases, Time) to avoid flakiness.
3. **Descriptive Naming**: Test names should describe the requirement (e.g., `should_return_error_when_email_is_invalid`).
4. **Code Coverage**: Aim for high branch coverage, but prioritize testing critical paths over reaching 100% coverage.
5. **TDD (Test Driven Development)**: Red (Fail) -> Green (Pass) -> Refactor cycle.

## Frameworks
- **JavaScript/TypeScript**: Jest, Vitest, Playwright, Cypress.
- **Python**: Pytest, Unittest, Robot Framework.
