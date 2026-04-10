---
name: coding-fullstack
description: >
  No description provided.
author: Lollms User
version: 1.0.0
category: general
created: 2026-04-09
---

# Full-Stack Integration Expert

## End-to-End Workflow
- **Contract-First Development**: Define API schemas before starting frontend/backend implementation.
- **Shared Types**: Use TypeScript to share interfaces between client and server projects.
- **Environment Management**: Use `.env` files and secret managers for environment-specific configs.

## Common Patterns
- **Authentication Flow**: Login -> Server issues JWT -> Client stores in HttpOnly cookie -> Client includes in API requests.
- **Data Fetching**: Use SWR or React Query to handle caching, loading states, and automatic revalidation.
- **File Uploads**: Use signed URLs (S3/GCS) for large uploads instead of routing bytes through the application server.

## Integration Best Practices
1. **Graceful Failures**: Frontend should handle backend errors (4xx, 5xx) with user-friendly messages/empty states.
2. **CORS Policy**: Strictly whitelist allowed origins, methods, and headers.
3. **Optimistic UI**: Update the UI immediately for simple actions (like liking a post) and roll back if the server fails.
4. **CI/CD**: Automate testing, building, and deployment (Docker, GitHub Actions, Vercel/Railway).
