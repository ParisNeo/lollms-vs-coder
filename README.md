# Lollms VS Coder

[![Version](https://img.shields.io/github/v/release/ParisNeo/lollms-vs-coder?logo=github&style=flat-square)](https://github.com/ParisNeo/lollms-vs-coder/releases) 
[![License](https://img.shields.io/github/license/ParisNeo/lollms-vs-coder?style=flat-square)](https://github.com/ParisNeo/lollms-vs-coder/blob/main/LICENSE) 
[![Languages](https://img.shields.io/github/languages/top/ParisNeo/lollms-vs-coder?style=flat-square)](https://github.com/ParisNeo/lollms-vs-coder) 
[![Stars](https://img.shields.io/github/stars/ParisNeo/lollms-vs-coder?style=social)](https://github.com/ParisNeo/lollms-vs-coder/stargazers) 

**Lollms VS Coder** is a powerful, AI-powered Visual Studio Code extension that brings a suite of intelligent tools directly into your editor. It leverages any Lollms-compatible API (local or remote) to provide advanced code assistance, autonomous agent capabilities, context-aware chat, inline autocompletion, diagram rendering, and much more.

Now available in **English, French, Spanish, German, Arabic, and Chinese (Simplified)**! 🌍

---

## ⚔️ The 2026 Engineering Landscape: Lollms vs. Others

In an era where every tool has an "Agent," the difference lies in **Autonomy, Vision, and Sovereignty**. Lollms VS Coder isn't just a plugin; it's a private command center for autonomous software engineering.

| Feature | Lollms VS Coder | Continue.dev | GitHub Copilot (Pro+) |
| :--- | :--- | :--- | :--- |
| **Autonomy** | **Full** (Architect/Worker Loop) | **High** (Slash Agents) | **High** (Copilot Workspace) |
| **Compute Liberty** | ☁️/🏠 **Hybrid (Local + Remote)** | ✅ Flexible | ☁️ Cloud Only |
| **Model Agnostic** | 🔓 **Absolute** (Any binding) | ✅ Flexible | 🔒 Locked to MS/OpenAI |
| **Digital Sovereignty**| 🔒 **100% Local/Private** | ⚠️ Config Dependent | ❌ Cloud Mandatory |
| **Structural Vision** | ✅ **Integrated Visual Graphs** | ❌ Text/Code Only | ❌ Chat-based diagrams |
| **Collective IQ** | ✅ **Hybrid Herd Mode** | ❌ Single Model | ⚠️ Cloud "Squads" |
| **Project Memory** | ✅ **Long-term Project Facts** | ❌ Session-based | ⚠️ Org-level only |

---

## 🚀 The Lollms Edge: Why we stan better

### 1. Visual Structural Intelligence (The HUD)
While other tools treat your project as a giant text file, Lollms builds a **Live Architecture Graph**. It provides a visual Head-Up Display (HUD) of your function calls and class hierarchies. Both you and the AI "see" the structural impact of changes in real-time, preventing the "spaghetti code" common with blind AI generation.

### 2. The "Hybrid Herd" Advantage
Don't trust one model? Lollms orchestrates a **Cross-Provider Debate**. You can have a fast **Ollama** model handle the boilerplate, a **Groq**-powered model critique the logic, and a **DeepSeek** or **Claude** instance finalize the architecture. This multi-perspective verification is the gold standard for mission-critical code.

### 3. 100% Sovereignty & AI Act Compliance
Lollms is built on the philosophy of **Digital Independence**. It doesn't just "support" local models; it was born for them. By design, there is zero telemetry and zero hidden data exfiltration. Whether you are running a 100% air-gapped **Ollama** instance or connecting to high-performance **Remote APIs** like Groq or Anthropic, your project orchestration remains private and local. It is the only professional tool fully aligned with **European AI Act** transparency and data residency standards.

### 4. The "Best of Both Worlds" Infrastructure
Lollms gives you the power to optimize for **Cost, Speed, or Intelligence**. 
- **Stay Local**: Use **Llama.cpp** or **Ollama** for total privacy and zero cost.
- **Go Remote**: Connect to **OpenAI, Anthropic, Google Gemini, or Groq** for state-of-the-art reasoning.
- **Mix & Match**: Configure your **Herd** to use local models for review and remote models for drafting.

### 5. Project-Specific Long-Term Memory
Ever notice how AI assistants repeat the same naming or logic mistakes every day? Lollms uses **Project Memory** to save technical constraints, architectural decisions, and bug-fix patterns permanently within your `.lollms` folder. It learns your project’s unique "DNA" and never forgets it.

---

## 🌟 Key Features

| Feature                  | Description                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🤖 **Autonomous Agent**      | Give the AI a complex objective, and it will generate and execute a multi-step plan, including creating files, writing code, running commands, and self-correcting.      |
| ⚡ **Quick Edit Companion**  | A lightweight, floating window for fast code edits, explanations, or questions without leaving your current context (Ctrl+Shift+L).                                     |
| 🧠 **Smart Context**         | A sidebar file tree lets you precisely control which files and folders the AI can "see." Includes an AI-powered auto-selection tool to find relevant context for any task. |
| 📝 **Smart Edits**           | Apply AI-generated code directly to your files with a single click, supporting both full-file updates and diff patching.                                                |
| 🎭 **Personalities**         | Switch between specialized AI personas like "Python Expert", "Senior Architect", or "Security Reviewer" to tailor the AI's behavior to your current task.               |
| 🕵️ **Commit Inspector**      | Analyze git commits for security vulnerabilities, bugs, and code quality issues with a single click.                                                                    |
| 📓 **Jupyter Integration**   | Enhance your data science workflow with tools to generate, explain, visualize, and fix notebook cells.                                                                  |

---

## 🚀 Installation & Setup

1.  Install [lollms-vs-coder](https://marketplace.visualstudio.com/items?itemName=parisneo.lollms-vs-coder) from the Visual Studio Marketplace.
2.  Open the Lollms sidebar in VS Code (click the Lollms icon in the activity bar).
3.  In the **Actions** view, click the **<span class="codicon codicon-gear"></span> Settings** item to open the configuration panel.
4.  Enter your Lollms API Host (e.g., `http://localhost:9642`) and select your desired model.

---

## 💬 Standard Discussions

The **Lollms Chat** is your central hub for interacting with the AI.

*   **Start a Chat**: Click the `+` icon in the **Discussions** sidebar view.
*   **Manage Context**: Use the **AI Context Files** view to control what the AI sees:
    *   **✅ Included**: The AI reads the full file content.
    *   **📄 Tree-Only**: The AI sees the file path but not the content (saves tokens).
    *   **🚫 Excluded**: The file is hidden from the AI.
*   **Attach Files**: Click the paperclip icon or drag & drop images and documents directly into the chat area.

---

## 🛠️ Discussion Tools & Thinking Mode

Customize how the AI behaves for each specific discussion by clicking the **Discussion Settings** (Gear Icon ⚙️) inside the chat panel.

### 🧠 Activate Thinking Mode
For complex tasks requiring logic and reasoning, enable **Thinking Mode**.
1.  Open **Discussion Settings**.
2.  Select a **Reasoning Strategy**:
    *   **Chain of Thought**: Forces the AI to show its step-by-step reasoning.
    *   **Plan and Solve**: Creates a plan before executing.
    *   **Self-Critique**: The AI checks its own answer for errors before responding.
    *   **No Think**: Disables reasoning for faster, direct answers.

### 🌐 Web Search
Toggle **Web Search** in the settings to allow the AI to browse the internet for up-to-date information (requires Google Custom Search configuration).

---

## 📝 Applying Code Changes

When the AI generates code, it provides interactive buttons to apply the changes directly to your project.

### 1. Full File Updates
If the AI generates a `File: path/to/file.ext` block:
*   Click **⚙️ Apply to File**.
*   A diff view will open, allowing you to review the changes before saving.

### 2. Diff / Patching
If the AI generates a `Diff:` or patch block:
*   Click **⚙️ Apply Patch**.
*   The extension attempts to intelligently apply the diff to the target file.

### 3. Insert / Replace
*   **Insert**: Inserts the code block at your current cursor position in the active editor.
*   **Replace**: Replaces your current selection with the generated code.

---

## ⚡ The Companion Panel (Quick Edit)

Press `Ctrl+Shift+L` (or `Cmd+Shift+L` on Mac) to open the **Companion Panel**. This is a persistent, floating window designed for rapid iteration.

*   **Context Aware**: Automatically tracks your active editor selection.
*   **Attach/Detach**: Pin the companion to a specific file or selection to keep the context fixed while you navigate other files.
*   **History**: Keeps a local history of your quick interactions.

---

## 📓 Jupyter Notebook Integration

Lollms VS Coder supercharges your `.ipynb` notebooks with context-aware AI tools found in the cell toolbar:

*   **$(book) Educative Notebook**: Generates a comprehensive, step-by-step notebook on a topic.
*   **$(sparkle) Enhance**: Refactors and improves the code in the current cell.
*   **$(wand) Generate Next**: Reads the current cell and generates the logical next step.
*   **$(info) Explain**: Adds a markdown cell explaining the logic of the code cell.
*   **$(graph) Visualize**: Generates code to visualize the data in the cell's output.
*   **$(debug-restart) Fix Error**: If a cell execution fails, a "Fix with Lollms" button appears to analyze and fix the error.

---

## 🤖 Agent Tools

When in **Agent Mode**, the AI can autonomously use tools to complete complex objectives:

| Tool Category | Tools |
| :--- | :--- |
| **File Operations** | `read_file`, `generate_code` (create/overwrite), `list_files`, `search_files` |
| **Execution** | `execute_command` (Shell), `execute_python_script` |
| **Research** | `search_web` (Google), `search_arxiv` (Papers), `scrape_website` |
| **Python** | `create_python_environment`, `install_python_dependencies`, `set_vscode_python_interpreter` |
| **Planning** | `edit_plan` (Dynamic self-correction) |
| **Context** | `auto_select_context_files`, `read_code_graph`, `request_user_input` |
| **Creative** | `generate_image` |

---

## Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/ParisNeo/lollms-vs-coder/issues).

---

## License

This project is licensed under the Apache-2.0 License - see the [LICENSE](https://github.com/ParisNeo/lollms-vs-coder/blob/main/LICENSE) file for details.