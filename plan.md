# 🏛️ Architecture & Protocol Specification: Lollms Single-Turn Assistant & Librarian System

## 1. Executive Summary & Core Invariants

### 1.1 Problem Diagnosis & Motivation
1. **Redundant Plan vs. Code Split**:
   In older versions, the assistant produced an architectural plan in Turn 1, waited for the user to confirm in Turn 2, and finally produced code in Turn 3.
   - Every additional turn forces re-transmission of the entire prompt context (system instructions, project file tree, and loaded file contents).
   - In VS Code, every file modification emitted via `<file path="..." action="...">` tags is already rendered as an interactive visual diff card with an explicit human **Apply** button.
   - Therefore, splitting planning and coding into separate turns burns thousands of input tokens with zero added safety.
2. **Context Window Pollution & Ambiguity**:
   Echoing lists of dozens or hundreds of muted files (`[M]`) wastes significant tokens. The worker already sees the tree manifest where muted files are tagged `[M]`.
3. **Circular Loops in Codebase Discovery**:
   Without an explicit history of prior deductions and executed tools, codebase scouts repeat searches or re-read previously inspected files.

### 1.2 Core Architectural Principles
- **Unified Single-Turn Delivery**: The Worker outputs its architectural explanation and production-ready `<file>` code updates in the **same turn**. The user inspects and applies changes via interactive diff review cards.
- **Verify Ingredients First**: The Worker verifies whether all necessary files, definitions, and contracts are already available in the project tree, loaded files (`[C]`), conversation history, or hydrated memories before calling the Librarian. It calls the Librarian ONLY if crucial information is genuinely missing.
- **Decisive Implementation & Form Restrictions**: The Worker does not pause to ask for user confirmation when the solution is clear. It ONLY uses interactive `<lollms_form>` choices when multiple viable solutions exist or there is genuine ambiguity. Coding is the definitive final action once 100% sure.
- **Fast Mode (Strict User-Unmuted Boundary)**:
  - The model operates strictly on files currently unmuted and loaded into context (`[C]`).
  - It cannot modify other files.
  - If changes in unmuted files are clear, it emits high-confidence `<file>` tags immediately.
  - If external dependencies are required, it updates what it can and asks the user to add/unmute specific files.
- **Standard Mode (Worker ↔ Librarian Collaboration)**:
  - If context is missing, the Worker summons the Librarian (`<librarian>...</librarian>`).
  - The Librarian receives the Worker's scouting query, the user's original objective, and recent conversation history (compressed if long) to provide complete grounding.
  - **Turns vs. Rounds Distinction**:
    * **Debate Turns (`librarianDebateTurns`, default: 2)**: Number of conversational exchanges between the Worker and Librarian per user request.
    * **Tool Rounds (`contextGovernorMaxRounds`, default: 15)**: Number of sequential tool calls (`<read_full_file>`, `<peek_files>`, `<grep>`, `<sparql>`) the Librarian may execute per consultation.
  - **Zero-Muted Echo**: The Librarian never lists muted files. It outputs verified function/method signatures, system mechanics, and explicit reasons for unmuting edit files.
  - **Dated & Tagged Memory Ingestion**: The Librarian records findings with ISO timestamps and `#architecture`/`#contracts` tags, allowing the background Dream Cycle to supersede stale knowledge.

---

## 2. System State Machine & Workflow

```
                                  ┌─────────────────────────┐
                                  │       USER PROMPT       │
                                  └────────────┬────────────┘
                                               │
                        ┌──────────────────────┴──────────────────────┐
                        │ Is Fast Mode active?                        │
                        └──────────────┬──────────────────────┬───────┘
                                       │                      │
                               YES (Fast Mode)          NO (Standard Mode)
                                       │                      │
                                       ▼                      ▼
             ┌───────────────────────────────────┐ ┌───────────────────────────────────────┐
             │  Operate ONLY on unmuted files    │ │  Worker Self-Assessment:              │
             │  - Modify unmuted files directly  │ │  Does it have all needed contracts,   │
             │  - High-confidence edits applied  │ │  definitions, and source files?       │
             │  - If files missing, prompt user  │ └───────────────────┬───────────────────┘
             │    to add or unmute them          │                     │
             └─────────────────┬─────────────────┘         YES ────────┴──────── NO
                               │                            │                     │
                               │                            │                     ▼
                               │                            │  ┌───────────────────────────────────┐
                               │                            │  │  Worker emits <librarian>         │
                               │                            │  │  - Librarian runs up to 15 rounds │
                               │                            │  │  - Deduplicates grep/read/sparql  │
                               │                            │  │  - Unmutes edit files, mutes rest │
                               │                            │  │  - Saves dated & tagged memory    │
                               │                            │  │  - Returns detailed report        │
                               │                            │  └──────────────────┬────────────────┘
                               │                            │                     │
                               │                            │  ┌──────────────────┴────────────────┐
                               │                            │  │  Debate Turn Gate (max 2 turns)   │
                               │                            │  │  Worker requests more info or     │
                               │                            │  │  emits <librarian_off> to conclude│
                               │                            │  └──────────────────┬────────────────┘
                               │                            │                     │
                               │                            └──────────┬──────────┘
                               │                                       │
                               ▼                                       ▼
             ┌─────────────────────────────────────────────────────────────────────────────┐
             │                          WORKER IMPLEMENTATION                              │
             │  - Delivers architectural explanation and verified <file> tags in ONE turn  │
             │  - Inline self-assessment auditing imports, brackets, types, and SOLID      │
             │  - User reviews changes via VS Code interactive diff cards & clicks Apply   │
             └─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Actor Roles & Operational Protocols

### 3.1 The Worker (Lead Architect & Developer)
- **Environment Awareness**:
  - Sees the project tree with state markers (`[C]` content loaded, `[M]` muted, unpossessed).
  - Sees the Knowledge Ledger (`KNOWLEDGE.md`) and active Project Memory.
  - Sees full source code for possessed files under `LOADED FILE CONTENTS`.
- **Fast Mode Behavior**:
  - Bound to unmuted files (`[C]`).
  - Applies modifications directly.
  - Requests user to unmute missing files if cross-file changes are required.
- **Standard Mode Behavior**:
  - Asks itself whether it has complete visibility of the target logic.
  - If missing, delegates to the Librarian via `<librarian>...</librarian>`.
  - Allowed up to **`librarianDebateTurns`** (default: 2) exchanges with the Librarian.
  - Concludes with `<librarian_off>\npath/to/target.ext\n</librarian_off>`.
  - Implements code and explains architecture in the **same response**.

### 3.2 The Librarian (Codebase & Knowledge Scout)
- **Scope & Autonomy**:
  - Autonomous background agent running inside `<librarian>` consultations.
  - Allowed up to **`contextGovernorMaxRounds`** (default: 15) consecutive tool calls per consultation.
- **Tools Available**:
  - `<read_full_file path="..." />`: Single-round complete file inspection.
  - `<peek_files path="..." lines="N" from="top|bottom" />`: Bounded line slice inspection.
  - `<grep pattern="..." path="..." />`: Codebase text search.
  - `<sparql query="..." />`: Architecture Graph AST & ontology queries.
  - `<add_files_to_context>`: Bring files into the candidate pool.
  - `<structure action="patch">`: Update `.lollms/structure.md` findings.
- **Loop Prevention & Self-Awareness**:
  - Remembers prior deductions, observations, and tool calls across rounds.
  - Sees remaining rounds countdown: `Round X of 15 (Z remaining)`.
  - Deduplication shield blocks repeated calls to the same path or pattern.
- **Zero-Muted Echo**:
  - Never outputs lists of muted files.
  - Reports:
    1. **Active Files for Modification `[C]`** with the exact reason for unmuting.
    2. **System & Flow Mechanics** explaining module interactions.
    3. **Method & Function Signatures** (parameters, return types, line numbers).
    4. **Tokens Liberated** summary.

---

## 4. Memory Integration & Dream Cycle Reconciliation

### 4.1 Dated & Tagged Engram Ingestion
Every completed Librarian session automatically persists its architectural findings:
- Target: `.lollms/knowledge.ttl` (Knowledge Graph) and `projectMemoryManager` (Persistent Memory Vault).
- Metadata:
  - Tags: `#architecture`, `#contracts`, `#librarian`.
  - Predicate: `recorded_at` with ISO 8601 timestamp (`YYYY-MM-DDTHH:mm:ss.sssZ`).
  - Relations: `explains` pointing to related files.

### 4.2 Dream Cycle Supersedence Algorithm
During the background Neural Dream Cycle:
1. Engrams tagged with `#architecture` or belonging to the `architecture` category are grouped by normalized topic title.
2. For topics with multiple entries, engrams are sorted by `recorded_at` / creation timestamp descending.
3. The newest engram receives an importance boost (+10, capped at 100).
4. Older engrams on the same topic have their importance decayed (-40). Engrams dropping &le; 20 are pruned.
5. This ensures that when codebase contracts change, newer Librarian findings automatically supersede stale information without manual cleanup.

---

## 5. Configuration & Capability Reference

| Setting Key | Default | Type | Description |
| :--- | :---: | :---: | :--- |
| `lollmsVsCoder.fastMode` | `false` | `boolean` | Restricts assistant strictly to user-unmuted files with immediate single-turn code generation. |
| `lollmsVsCoder.librarianDebateTurns` | `2` | `number` (1–10) | Maximum conversational exchanges between Worker and Librarian per user request. |
| `lollmsVsCoder.contextGovernorMaxRounds` | `15` | `number` (1–30) | Maximum internal tool calls the Librarian can execute in sequence per consultation turn. |
| `lollmsVsCoder.contextGovernorThreshold` | `95` | `number` (10–99) | Context window percentage that triggers automatic budget balancing. |
| `lollmsVsCoder.contextGovernorTargetThreshold` | `70` | `number` (10–90) | Target context percentage to reduce down to after arbitration. |

---

## 6. Implementation Status & Checklist

- [x] **Single-Turn Delivery**: Unified planning and `<file>` code block emission in `promptTemplates.ts` and `profiles.ts`.
- [x] **Fast Mode Invariant**: Strict restriction to user-unmuted files with guidance to prompt the user if additional files are needed.
- [x] **Debate Turns vs. Tool Rounds Separation**:
  - `librarianDebateTurns` (default 2) controls Worker-Librarian invocations in `chatPanel.ts`.
  - `contextGovernorMaxRounds` (default 15) controls Librarian internal tool loops in `contextLibrarian.ts`.
  - Both settings independently exposed in `package.json`, `DiscussionCapabilities`, `discussionManager.ts`, and the Discussion Settings modal.
- [x] **Muted Files Purge**: Completely eliminated listing dozens of muted files from Librarian reports across `chatPanel.ts` and `contextLibrarian.ts`.
- [x] **Concrete Contract Reporting**: Librarian reports method/function signatures, line numbers, system mechanics, and reasons for unmuting.
- [x] **Anti-Looping Circuit Breakers**: `executedToolSignatures` deduplication and cumulative thought ledger in `ContextLibrarian`.
- [x] **Dated Memory & Dream Reconciliation**: Timestamped engrams ingested by Librarian and reconciled by timestamp in `ProjectMemoryManager.performDreamCycle`.
</file>

### Summary of Changes in `PLAN.md`

1. **Executive Summary & Principles**:
   - Codified the **Single-Turn Delivery** invariant (no artificial turn-split between planning and code, preventing redundant prompt context resending).
   - Documented the **Fast Mode** strict boundary (operates exclusively on user-unmuted files with user-escalation for missing files).
2. **Clear Separation of Turns vs. Rounds**:
   - **Debate Turns (`librarianDebateTurns`, default 2)**: How many times the Worker can invoke the Librarian per user request.
   - **Tool Rounds (`contextGovernorMaxRounds`, default 15)**: How many subsequent tool calls the Librarian can execute in sequence during each consultation.
3. **Actor Specifications**:
   - Detailed the Worker's fast-path vs. standard mode self-assessment.
   - Enforced the Librarian's **Zero-Muted Echo** mandate (never echoing lists of muted files that are already visible in the tree).
   - Specified concrete signature and contract extraction from AST/Code Graph.
4. **Memory & Dream Cycle Architecture**:
   - Documented dated & tagged engram ingestion (`recorded_at` ISO timestamps, `#architecture`, `#contracts`).
   - Detailed the timestamp-based supersedence and decay algorithm in `ProjectMemoryManager`.
5. **Configuration Table & Checklist**:
   - Added complete configuration reference table and updated all checklist items to reflect the current codebase state.