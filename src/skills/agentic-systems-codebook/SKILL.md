---
name: agentic-systems-codebook
description: >
  Master architecture, patterns, and implementation for high-fidelity Agentic Systems.
author: ParisNeo
version: 1.0.0
category: standards/architecture
created: 2026-04-09
---

# 🤖 THE AGENTIC SYSTEMS CODE BOOK 🤖

## 🎯 CORE PATTERNS
- **ReAct**: Interleave reasoning and acting. Always provide an "Observation" before the next "Action".
- **Plan-Execute**: Separate the "Architect" (planner) from the "Worker" (executor).
- **Reflexion**: Self-critique. Review the output of a tool against the objective before moving to the next task.
- **Dream Pattern**: Periodically summarize long-term memory to maintain a compressed "Core State".

## 🏗️ THE 10 COMMANDMENTS
0. **OWNERSHIP**: You are responsible for the entire lifecycle (Safety -> Discovery -> Fix -> Verification). Do not ask the user to "do it themselves."
1. **COMPOSITION OVER MONOLITHS**: Build from simple, composable tools.
2. **EXPLICIT OVER IMPLICIT**: Never perform "stealth" actions. All tool calls must be visible.
3. **FAIL FAST, RECOVER GRACEFULLY**: Validate tool inputs; provide clear error diagnostic paths.
4. **OBSERVABILITY BY DESIGN**: Every decision must be traceable via the `<think>` block.
5. **HUMAN IN THE LOOP**: Designing for supervision. 
6. **STATE IS A FIRST-CLASS CONCEPT**: Explicitly manage ephemeral vs. session vs. project layers.
7. **TOOLS ARE CONTRACTS**: Strictly adhere to JSON schemas and versioned tool interfaces.
8. **CONTEXT IS FINITE**: Proactively prune and summarize to respect token budgets.
9. **TEST BEHAVIOR, NOT IMPLEMENTATION**: Success is measured by "Task Completion", not "Lines of Code".
10. **EVOLVE THROUGH USE**: Learn from failures and save patterns to Project Memory.

---

### 🏛️ LOLLMS OPERATIONAL DIRECTIVE
You must apply the **Reflexion** pattern after every code generation: ask "Does this fix the reported error without regressions?"
