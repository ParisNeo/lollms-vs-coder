# Lollms VS Coder: The Autonomous Engineering Command Center

[![Version](https://img.shields.io/github/v/release/ParisNeo/lollms-vs-coder?logo=github&style=flat-square)](https://github.com/ParisNeo/lollms-vs-coder/releases) 
[![License](https://img.shields.io/github/license/ParisNeo/lollms-vs-coder?style=flat-square)](https://github.com/ParisNeo/lollms-vs-coder/blob/main/LICENSE) 
[![Languages](https://img.shields.io/github/languages/top/ParisNeo/lollms-vs-coder?style=flat-square)](https://github.com/ParisNeo/lollms-vs-coder) 

**Lollms VS Coder** is a private, local-first (hybrid) AI engineering suite integrated deeply into VS Code. It transforms the AI from a simple "Chatbot" into a **Verifiable Engineering Operator** that plans, executes, and self-heals your code.

Now available in **English, French, Spanish, German, Arabic, and Chinese (Simplified)**! 🌍

---

## ⚔️ The 2026 Landscape: Lollms vs. The World

In an era of generic AI "Copilots," Lollms provides **Sovereignty, Structural Intelligence, and Verifiable Autonomy**.

| Feature | Lollms VS Coder | Cursor / Windsurf | GitHub Copilot |
| :--- | :--- | :--- | :--- |
| **Philosophy** | **Operator** (Verify & Fix) | Assistant (Suggest) | Assistant (Suggest) |
| **Compute** | 🏠/☁️ **Hybrid (Ollama/Groq)** | ☁️ Cloud (MANDATORY) | ☁️ Cloud (MANDATORY) |
| **Vision** | 📊 **Interactive Call Graphs** | ❌ Text only | ❌ Text only |
| **Data Privacy** | 🔒 **Zero Telemetry** | ⚠️ "Privacy Mode" opt-in | ❌ High Telemetry |
| **Protocol** | 🛡️ **Guardian (Self-Healing)** | ❌ Manual Fixes | ❌ Manual Fixes |
| **Memory** | 🧠 **Infinite Project DNA** | ⚠️ RAG Indexing only | ⚠️ Org-level only |

---

## 🚀 The Lollms Edge: Why choose us?

### 1. 🎭 Expert Personalities (The Digital Twin)
Lollms doesn't just "chat." It allows you to inhabit a specific **Expert Persona**. Need a deep security audit? Switch to the **Security Auditor**. Refactoring a complex backend? Invoke the **Senior Architect**. These aren't just labels; they are deep behavioral overrides that change how the AI plans, critiques, and writes code. You can even build your own custom personas using the built-in **Personality Builder**.

### 2. 💎 Modular Skills (The Source of Truth)
Stop relying on the AI's "hallucination-prone" general knowledge. **Lollms Skills** are atomic, verified knowledge capsules. 
- **Diamond Protocol**: When a skill is active (e.g., "FastAPI 2026 standards"), the AI prioritizes the skill's documentation over its internal training data.
- **Global & Local**: Keep project-specific protocols (e.g., "Our Team's naming convention") in your local library, and share core coding patterns across all your projects via the global library.
- **Agent Integration**: When the Lead Architect delegates tasks, it can explicitly "equip" sub-agents with specific skills to ensure perfect compliance.

### 3. 🛡️ The "Guardian" Protocol (Self-Healing Code)
Lollms doesn't just write code and hope it works. When the **Architect** applies changes, the **Guardian** immediately scans for functional errors using the VS Code engine. If an error is found, the AI spawns a **Repair Mission** autonomously, fixing logic or "ghost" imports *before* you even review the result.

### 2. 📊 Structural Intelligence (The HUD & The Graph)
Stop navigating blindly. Lollms provides two layers of structural vision:
- **The Visual Graph**: A full-project map with SPARQL query support to analyze deep dependencies.
- **The Surgical HUD**: A high-speed, inline analyzer. Click the ✨ **Lollms HUD** button above any function to instantly see its architectural risks and potential bugs without leaving the code.
- **SPARQL Queries**: Run queries like `SELECT ?x WHERE { ?x imports 'auth.ts' }` to understand impact.
- **Isolate View**: One click to hide everything except the file you're refactoring and its direct neighbors.

### 3. 🎯 Mission Briefing (Prime Directive)
Standard AI chat suffers from "context drift." Lollms introduces the **Mission Briefing**. Pin specific constraints (e.g., *"Must use Python 3.12, No external libraries"*) to a dedicated briefing zone. These rules are treated as the **Prime Directive**, remaining the AI's highest priority regardless of how long the chat becomes.

### 4. 🧬 Project DNA (Automated Standards)
Lollms can extract a "DNA" profile of your project (naming conventions, folder patterns, tech stack). It saves this to **Project Memory**, ensuring the AI understands your project's unique identity across all discussions.

---

## 🌟 Key Features

| Feature                  | Description                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🎭 **Expert Personas**     | Over 10+ built-in professional roles (Architect, Embedded Expert, Security Lead, etc.) that change the AI's logic, tone, and technical priorities.                      |
| 💎 **Skills Library**      | A modular library of verified code patterns, API docs, and standards. Acts as a "Source of Truth" that overrides generic model behavior.                                |
| 🤖 **Autonomous Agent**      | Give the AI a complex objective, and it will generate and execute a multi-step plan, including creating files, writing code, running commands, and self-correcting.      |
| 📊 **Architecture Graph**  | Visualize your project structure with interactive call graphs and class diagrams. Supports SPARQL queries for deep dependency analysis.                               |
| 🛡️ **Guardian Audit**       | Background self-healing loop. The AI automatically detects and repairs linting or import errors in generated code before finalizing tasks.                             |
| ⚡ **Quick Edit Companion**  | A lightweight, floating window for fast code edits, explanations, or questions without leaving your current context (Ctrl+Shift+L).                                     |
| 🧠 **Smart Context**         | A sidebar file tree lets you precisely control which files the AI can "see." Includes **🔍 Definitions-Only** mode to save tokens while keeping API visibility. |
| 📝 **Smart Edits**           | Apply AI-generated code directly to your files with a single click, supporting both full-file updates and Aider-style SEARCH/REPLACE patching.                        |
| 🕵️ **Commit Inspector**      | Analyze git commits for security vulnerabilities, bugs, and code quality issues with a single click.                                                                    |
| 📓 **Jupyter Integration**   | Enhance your data science workflow with tools to generate, explain, visualize, and fix notebook cells.                                                                  |

---

## 🚀 Installation & Setup

1.  Install [lollms-vs-coder](https://marketplace.visualstudio.com/items?itemName=parisneo.lollms-vs-coder) from the Visual Studio Marketplace.
2.  Open the Lollms sidebar in VS Code (click the Lollms icon in the activity bar).
3.  In the **Navigation** view, click the **<span class="codicon codicon-gear"></span> Settings** item to open the configuration panel.
4.  Enter your Lollms API Host (e.g., `http://localhost:9642` or your local Ollama address) and select your desired model.

---

## 💬 Standard Discussions

The **Lollms Chat** is your central hub for interacting with the AI.

*   **Start a Chat**: Click the `+` icon in the **Discussions** sidebar view.
*   **Manage Context**: Use the **AI Context Files** view to control what the AI sees:
    *   **✅ Included**: The AI reads the full file content.
    *   **🔍 Definitions**: The AI sees the file structure (classes/functions) but not implementation details.
    *   **📄 Tree-Only**: The AI sees the file path but not the content (saves tokens).
    *   **🚫 Excluded**: The file is hidden from the AI.
*   **Mission Briefing**: Use the **🛡️ Briefing** button to set task-specific constraints that stay at the top of the AI's memory.
*   **Attach Files**: Click the paperclip icon or drag & drop images and documents directly into the chat area.

---

## 🛠️ Discussion Tools & Thinking Mode

Customize how the AI behaves for each specific discussion by clicking the **Discussion Settings** (Gear Icon ⚙️) inside the chat panel.

### 🧠 Activate Thinking Mode
For complex tasks requiring logic and reasoning, enable **Thinking Mode**.
1.  Open **Discussion Settings**.
2.  Select a **Reasoning Strategy** (e.g. Chain of Thought, Plan and Solve).

### 🌍 Web Search & Research Agent
Toggle **Web Search** in the settings to allow the AI to browse the internet. When enabled, Lollms spawns a specialized **Research Librarian** to verify facts or read library documentation.

---

## 📝 Applying Code Changes

When the AI generates code, it provides interactive buttons to apply the changes directly to your project.

### 1. Full File Updates
If the AI generates a `File: path/to/file.ext` block:
*   Click **⚙️ Apply to File**.
*   A diff view will open, allowing you to review the changes before saving.

### 2. Diff / Patching (Aider Format)
Lollms excels at **SEARCH/REPLACE** blocks. This is the safest way to modify existing files without losing your local changes.
*   Click **⚙️ Apply Patch**.
*   The **Guardian Protocol** will automatically verify the change doesn't introduce syntax errors.

### 3. Insert / Replace
*   **Insert**: Inserts the code block at your current cursor position in the active editor.
*   **Replace**: Replaces your current selection with the generated code.

---

## ⚡ The Companion Panel (Quick Edit)

Press `Ctrl+Shift+L` (or `Cmd+Shift+L` on Mac) to open the **Companion Panel**. This is a persistent, floating window designed for rapid iteration.

*   **Context Aware**: Automatically tracks your active editor selection.
*   **Attach/Detach**: Pin the companion to a specific file or selection to keep the context fixed while you navigate other files.

---

## 📓 Jupyter Notebook Integration

Lollms VS Coder supercharges your `.ipynb` notebooks with context-aware AI tools found in the cell toolbar:

*   **$(book) Educative Notebook**: Generates a comprehensive, step-by-step notebook on a topic.
*   **$(sparkle) Enhance**: Refactors and improves the code in the current cell.
*   **$(graph) Visualize**: Generates code to visualize the data in the cell's output.
*   **$(debug-restart) Fix Error**: If a cell execution fails, a "Fix with Lollms" button appears to analyze and fix the error.

---

## 🤖 Agent Tools

When in **Agent Mode**, the AI can autonomously use tools to complete complex objectives:

| Tool Category | Tools |
| :--- | :--- |
| **File Operations** | `read_file`, `generate_code`, `delete_file`, `move_file` |
| **Execution** | `execute_command`, `run_file`, `run_tests_and_fix` |
| **Architecture** | `update_code_graph`, `read_code_graph` |
| **Knowledge** | `store_knowledge` (RLM), `extract_project_dna` |
| **Research** | `search_web`, `search_arxiv`, `search_wikipedia`, `scrape_website` |
| **Communication** | `moltbook_action` (Agent Social Network), `submit_response` |
| **Planning** | `edit_plan` (Self-Correction), `wait` |

---

## Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/parisneo/lollms-vs-coder/issues).

---

## License

This project is licensed under the Apache-2.0 License - see the [LICENSE](https://github.com/ParisNeo/lollms-vs-coder/blob/main/LICENSE) file for details.