# 🏛️ Architecture Plan: Grounded Assistant & Librarian Debate Protocol

## 1. Executive Summary & Problem Diagnosis

### 1.1 Symptoms
- **Conversational Looping**: The assistant currently wanders in multi-round loops, promising to check files without taking action or repeatedly requesting files already in memory.
- **Token Inflation**: Massive raw tool outputs (grep dumps, file peeks, full listings) accumulate directly inside the conversation history, crowding out the model's working memory.
- **Hallucination Under Load**: When the context size swells beyond optimal attention thresholds, the model forgets function signatures, assumes nonexistent paths, and emits malformed patches.
- **Lack of Role Separation**: The worker attempts to be a scout, grep engine, architect, and coder in the same turn without clear phase gating.

### 1.2 Target Architecture: Asymmetric Two-Actor System
```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                     USER PROMPT                                         │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │
                                            ▼
                           ┌───────────────────────────────────┐
                           │      WORKER (Lead Architect)      │
                           │ Sees: Tree, KNOWLEDGE.md, [C] Code│
                           └─────────────────┬─────────────────┘
                                             │
                       ┌─────────────────────┴─────────────────────┐
                       │ Does it have all necessary context?       │
                       └─────────────┬─────────────────────────────┘
                                     │
                     YES ────────────┴──────────── NO
                      │                             │
                      ▼                             ▼
        ┌───────────────────────────┐ ┌───────────────────────────────────────┐
        │     STAGE 2: PLAN         │ │           EMIT <librarian>            │
        │ - Technical breakdown     │ │ - Halts worker stream                 │
        │ - User confirmation gate  │ └───────────────────┬───────────────────┘
        └─────────────┬─────────────┘                     │
                      │                                   ▼
                      │               ┌───────────────────────────────────────┐
                      │               │       LIBRARIAN (Codebase Scout)      │
                      │               │ Sees: Tree, KNOWLEDGE.md, Tool outputs│
                      │               │ Tools: SPARQL, Grep, Peek, Knowledge  │
                      │               └───────────────────┬───────────────────┘
                      │                                   │
                      │                                   ▼
                      │               ┌───────────────────────────────────────┐
                      │               │ - Scrutinizes codebase & patterns     │
                      │               │ - Upgrades & uncollapses KNOWLEDGE.md │
                      │               │ - Unmutes edit files (Budget-checked) │
                      │               │ - Emits "Librarian agent report:"     │
                      │               └───────────────────┬───────────────────┘
                      │                                   │
                      │                                   ▼
                      │               ┌───────────────────────────────────────┐
                      │               │          DEBATE / HANDOVER            │
                      │               │ Worker reviews report vs actual code  │
                      │               │ Worker emits <librarian_off/> when OK │
                      │               └───────────────────┬───────────────────┘
                      │                                   │
                      └───────────────────────────────────┘
                                      │
                                      ▼
                        ┌───────────────────────────┐
                        │      USER CONFIRMS        │
                        └─────────────┬─────────────┘
                                      │
                                      ▼
                        ┌───────────────────────────┐
                        │     STAGE 3: CODING       │
                        │ - Manifests <file> tags   │
                        │ - Self-assessment audit   │
                        │ - Updates KNOWLEDGE.md    │
                        └───────────────────────────┘
```

---

## 2. Actor Specifications & Asymmetric Visibility

### 2.1 The Worker (Lead Developer & Implementer)
- **Primary Objective**: Understand user intent, evaluate technical feasibility, formulate an architectural plan, guide the user, implement verified code, and self-audit.
- **What the Worker Sees**:
  1. **Workspace Tree Manifest**: Directory scopes with state markers (`[C]` content loaded, `[M]` muted, unpossessed).
  2. **Active Knowledge Ledger (`KNOWLEDGE.md`)**: The root Abstract, Index, and top 30% dynamically uncollapsed sections.
  3. **Loaded Source Code (`[C]`)**: The full text of files actively loaded for editing.
  4. **Conversation History**: User requests, its own previous plans, and concise Librarian reports.
- **What the Worker DOES NOT See**:
  - Raw unmuted code of reference files (avoids bloating its attention budget).
  - Multi-round raw tool execution outputs (grep lines, file peeks from earlier research).
- **Authorized Tags**:
  - `<librarian query="...">...</librarian>`: Starts or continues a session with the Librarian.
  - `<librarian_off/>`: Signals that research is sufficient and transitions to Stage 2 Plan.
  - `<lollms_form>`: Interactive options form for user decision.
  - `<file path="..." action="write|patch|update_symbol">`: ONLY in Stage 3 after user confirmation.
  - `<update_knowledge path="...">`: Updates the Knowledge ledger post-implementation.

### 2.2 The Librarian (Knowledge & Codebase Scout)
- **Primary Objective**: Explore the codebase, understand component contracts and call graphs, update `KNOWLEDGE.md` with reusable facts and tested SPARQL queries, balance the token budget, and select the exact files to unmute.
- **What the Librarian Sees**:
  1. **Workspace Tree Manifest**: Detailed structure with tags (`[C]`, `[M]`, unpossessed).
  2. **Knowledge Ledger (`KNOWLEDGE.md`)**: Complete structure and section tree.
  3. **Tool Execution Logs**: Outputs from its own SPARQL queries, grep searches, peeks, and single-round reads.
- **What the Librarian DOES NOT See**:
  - The raw code of all files at once (it inspects them on demand via `<read_full_file>` or `<peek_files>` within its loop without polluting permanent context).
- **Authorized Tools**:
  - `<query_architecture>` / `<sparql>`: Query AST nodes, classes, methods, inheritances, and calls.
  - `<grep pattern="..." path="..." />`: Codebase text search.
  - `<peek_files path="..." lines="N" from="..." />`: Bounded line slice inspection.
  - `<read_full_file path="..." />`: Single-round complete file inspection.
  - `<load_knowledge>`: Uncollapse specific sections from `.lollms/knowledge/`.
  - `<update_knowledge path="...">`: Update or add knowledge sections.
  - `<unmute_files>`: Mark files as unmuted (`[C]`) within budget limits.
  - `<add_files_to_context>`: Bring new files into the candidate pool.

---

## 3. Detailed Protocol Flow

### 3.1 Turn Initiation & Initial Assessment
1. The user submits a prompt for a task.
2. The Worker assesses its current state:
   - Does it already have all required files loaded as `[C]`?
   - Does the Knowledge ledger answer the architecture questions?
3. **Branch A (Sufficient Context / Fast-Path to Phase 2)**:
   - Worker skips Phase 1 entirely (no `<librarian>` call).
   - Emits `<librarian_off>\npath/to/target_file.ext\n</librarian_off>`.
   - Worker immediately outputs Stage 2: Assessment & Plan.
   - Includes proposed files, changes, security measures, algorithmic complexity, and optional `<lollms_form>`.
   - Asks the user to confirm. **Zero `<file>` tags are emitted**.
4. **Branch B (Insufficient Context)**:
   - Worker immediately outputs:
     ```xml
     <librarian>
     I need to locate the implementations of [X] and understand how [Y] connects with [Z].
     Please inspect the relevant modules, update KNOWLEDGE.md, and unmute the exact files needed for modification.
     </librarian>
     ```
   - Streaming stops as soon as `</librarian>` is closed.

### 3.2 The Librarian Session (Autonomous Grounding)
1. The system detects the closed `</librarian>` tag and activates the Librarian loop.
2. The Librarian receives:
   - The user's original objective.
   - The worker's query.
   - The current tree state and `KNOWLEDGE.md`.
3. The Librarian runs multi-round discovery:
   - Queries the Code Graph with SPARQL to trace call hierarchies.
   - Runs `<grep>` to locate symbol definitions.
   - Reads or peeks at specific files.
   - If it learns new architectural contracts, it updates `KNOWLEDGE.md` using `<update_knowledge>`.
   - **Tested SPARQL Queries**: The Librarian records reusable SPARQL patterns in `KNOWLEDGE.md` under the relevant section so future turns can reuse them.
4. **Token Budget Verification**:
   - The Librarian checks the token size of files it wants to unmute.
   - If the files fit within the target budget (e.g. 70% of context capacity):
     - Unmutes the files via `<unmute_files>`.
   - If the files **exceed the budget**:
     - It **partitions the task** into sub-tasks (Part 1, Part 2).
     - Unmutes only the files for Part 1.
     - Notes the sub-task breakdown in its report.
5. The Librarian concludes its turn with a formatted message starting with:
   ```markdown
   Librarian agent report:
   ### Architectural Findings
   ...
   ### Updated Knowledge Sections
   ...
   ### Unmuted Edit Files ([C])
   - path/to/file1.ext (~1,200 tok)
   - path/to/file2.ext (~2,400 tok)
   ```

### 3.3 The Debate & Handover Loop
1. The Worker receives the Librarian's message in the discussion stream (as a user turn labeled `Librarian agent report:`).
2. The Worker inspects the newly unmuted code (`[C]`) and the Librarian's findings.
3. **If the Worker needs more info or disagrees**:
   - The Worker responds with:
     ```xml
     <librarian>
     The file path/to/file1.ext shows that [X] actually calls [W] which is not in our context. Please find [W].
     </librarian>
     ```
   - The Librarian resumes investigation.
4. **If the Worker has enough context**:
   - The Worker emits:
     ```xml
     <librarian_off/>
     ```
   - Followed immediately by its user-facing assessment and the Stage 2 Plan:
     - Exact files to create or modify.
     - Proposed changes and security checks.
     - Questions or choices for the user (via `<lollms_form>` if needed).
     - Request for user confirmation.

### 3.4 User Confirmation & Stage 3 Implementation
1. The user answers (e.g., "Proceed", submits form, or picks an option).
2. The Worker executes Stage 3 in a single comprehensive response:
   - Generates the code using `<file path="..." action="write|patch|update_symbol">`.
   - Conducts an **inline self-assessment** at the end of the message:
     * Audits imports: Were all referenced packages imported?
     * Audits type signatures and syntax.
     * Verifies against user preferences (SOLID, clean code, no placeholders).
   - If it finds self-identified flaws, it outputs the surgical patch in the same response.
   - Synchronizes `KNOWLEDGE.md` using `<update_knowledge>` with newly established contracts.

---

## 4. Context Budget Shield & Task Chunking Rules

### 4.1 Token Accounting Invariants
- `Context Capacity` = Model capacity (e.g., 128k, 200k tokens).
- `Trigger Threshold` = 95% of capacity.
- `Target Budget` = 70% of capacity.
- `Fixed Overhead` = System prompt + Tree manifest + Knowledge ledger + Chat history.
- `Available Code Budget` = Target Budget - Fixed Overhead.

### 4.2 Hard Shield Enforcement
1. **Pre-Unmute Gate**: The Librarian must sum `tokens(files_to_unmute)`. If `tokens(files_to_unmute) > Available Code Budget`, direct unmuting is blocked.
2. **Sub-Task Partitioning Protocol**:
   - The Librarian splits the edit list into ordered chunks: `Phase 1`, `Phase 2`, etc.
   - Each phase must independently satisfy: `tokens(phase_files) <= Available Code Budget`.
   - The Librarian unmutes only `Phase 1` files.
   - In its report, it informs the Worker:
     ```
     Sub-task partitioning active: 2 phases. Phase 1 targets [File A, File B]. Phase 2 will target [File C].
     ```
   - After Phase 1 is coded and verified, Phase 1 files are muted and Phase 2 files are unmuted for the next phase.

---

## 5. Implementation Roadmap & Step-by-Step Milestones

### Milestone 1: Protocols & Prompts Update
- [ ] Update `src/promptTemplates.ts` with the formal Worker & Librarian debate protocol, asymmetric visibility rules, and the `<librarian>` / `<librarian_off/>` tags.
- [ ] Update `src/registries/profiles.ts` to reflect the 3-stage protocol with debate capability in the default response profiles.

### Milestone 2: Assistant Chat Loop & Event Gating
- [ ] In `src/commands/chatPanel/chatPanel.ts`:
  - Detect closing of `<librarian>...</librarian>` tag in assistant stream.
  - Immediately pause assistant generation, spawn autonomous Librarian session using `ContextLibrarian`.
  - Inject Librarian findings as `Librarian agent report: ...` into discussion stream.
  - Resume Worker turn.
  - Handle `<librarian_off/>` to cleanly close research and transition to Stage 2 Plan.

### Milestone 3: Librarian Execution & Knowledge Sync
- [ ] In `src/contextLibrarian.ts`:
  - Ensure the Librarian only sees tree, `KNOWLEDGE.md`, tool outputs, and query.
  - Enable recording tested SPARQL queries into section knowledge files.
  - Integrate budget check: enforce hard threshold and produce `multiPartPlan` when budget overflows.
- [ ] In `src/knowledgeManager.ts`:
  - Support storing and reading SPARQL query blueprints in section markdown.

### Milestone 4: Webview UI & Plugin Integration
- [ ] Update `src/commands/chatPanel/webview/plugins/librarianPlugin.ts` to render the live status of the Librarian session and the debate handover cards cleanly.
- [ ] Ensure that all actions (`<librarian>`, `<librarian_off/>`, `<lollms_form>`) render gracefully in the chat panel with clear state badges.

### Milestone 5: Verification & End-to-End Testing
- [ ] Verify fast-path: When files are already `[C]`, verify that assistant goes straight to Stage 2 Plan without firing Librarian.
- [ ] Verify debate flow: When context is missing, verify `<librarian>` triggers autonomous scout, returns report, worker receives it, and worker produces plan.
- [ ] Verify budget shield: When a massive file set is requested, verify partitioning into sequential phases.
- [ ] Verify zero placeholders and clean code implementation in Stage 3.
</file>
```

---

### 4. Summary of Changes & Verification

- **Analyzed Root Causes**: Diagnosed token waste, conversational looping, and hallucination stems from role conflation, context window contamination with raw tool outputs, and lack of asymmetric visibility between the Worker and the Librarian.
- **Formulated Clear Architecture**:
  - **Worker (Lead Architect)**: Sees tree, `KNOWLEDGE.md`, and unmuted code (`[C]`). Evaluates requirements, formulates plans with user confirmation, conducts Stage 3 coding with self-assessment, and delegates context discovery via `<librarian>`.
  - **Librarian (Codebase Scout)**: Operates with asymmetric visibility (sees only tree, `KNOWLEDGE.md`, and its own tool outputs, not all raw code). Discovers structure via SPARQL, Grep, Peeks, and Single-Round Reads, updates `KNOWLEDGE.md`, unmutes target files within a hard token budget, and reports findings via `Librarian agent report:`.
  - **Debate & Handover Protocol**: Worker can query the Librarian, receive reports, request refinements, or signal readiness via `<librarian_off/>`.
  - **Context Budget Hard Shield**: Automatically partitions tasks into sequential sub-tasks (Part 1, Part 2) if files exceed the available budget.
- **Created `PLAN.md`**: Wrote the complete, production-grade specification in the root of the workspace without any placeholders or shortcuts, detailing actor roles, protocols, message formats, and a 5-milestone implementation roadmap.

Ready to proceed with Milestone 1 whenever you would like to begin the code updates!