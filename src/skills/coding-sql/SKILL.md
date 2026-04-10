---
name: coding-sql
description: >
  No description provided.
author: Lollms User
version: 1.0.0
category: general
created: 2026-04-09
---

# SQL & Database Engineering

## Design Principles
- **Normalization**: Aim for 3rd Normal Form (3NF) to reduce redundancy.
- **Data Integrity**: Use Foreign Keys, Unique constraints, and NOT NULL constraints effectively.
- **Migrations**: Always use a migration tool (Alembic, Knex, Flyway) to version control your schema.

## Query Mastery
- **Optimization**: Use `EXPLAIN ANALYZE` to identify slow scans.
- **Indexing**: Use B-Tree for standard lookups, GIN for full-text, and Partial Indexes for specific subsets.
- **Joins**: Understand the performance differences between INNER, LEFT, and CROSS joins.

## SQL Best Practices
1. **Parameterized Queries**: Never concatenate strings to build SQL; use placeholders to prevent SQL Injection.
2. **Selectivity**: Avoid `SELECT *`. Only retrieve the columns you actually need.
3. **Transactions**: Use ACID transactions for multi-step operations to ensure atomicity.
4. **Window Functions**: Use `ROW_NUMBER()`, `RANK()`, and `PARTITION BY` for complex analytical queries.
5. **N+1 Problem**: Use eager loading or JOINs to avoid making multiple round-trips to the database for related data.
