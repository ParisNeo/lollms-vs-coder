---
name: coding-frontend
description: >
  No description provided.
author: Lollms User
version: 1.0.0
category: general
created: 2026-04-09
---

# Frontend Development Expert

## Core Principles
- **Accessibility (a11y)**: Use semantic HTML. Ensure WCAG 2.1 compliance (ARIA labels, keyboard navigation, color contrast).
- **Performance**: Optimize Core Web Vitals (LCP, FID, CLS). Use lazy loading, code splitting, and efficient asset management.
- **Responsive Design**: Mobile-first approach using Flexbox/Grid and media queries.

## Frameworks & Tools
- **React**: Functional components, Hooks (useEffect, useMemo, useCallback), and Server Components.
- **Vue**: Composition API, script setup, and Vite-based tooling.
- **Tailwind CSS**: Utility-first styling, consistent spacing, and theme customization.
- **State Management**: Context API, Redux Toolkit, or Pinia.

## Frontend Best Practices
1. **Component Driven Development**: Keep components small, reusable, and single-responsibility.
2. **Type Safety**: Use TypeScript for all props, state, and API responses.
3. **Testing**: Unit test logic with Vitest/Jest; E2E test critical flows with Playwright/Cypress.
4. **State Locality**: Keep state as close to where it's used as possible to prevent unnecessary re-renders.
5. **Security**: Sanitize user inputs, use CSP headers, and avoid `dangerouslySetInnerHTML`.
