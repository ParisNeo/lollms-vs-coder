# Lollms VS Coder

[![Version](https://img.shields.io/github/v/release/ParisNeo/lollms-vs-coder?logo=github&style=flat-square)](https://github.com/ParisNeo/lollms-vs-coder/releases) 
[![License](https://img.shields.io/github/license/ParisNeo/lollms-vs-coder?style=flat-square)](https://github.com/ParisNeo/lollms-vs-coder/blob/main/LICENSE) 
[![Languages](https://img.shields.io/github/languages/top/ParisNeo/lollms-vs-coder?style=flat-square)](https://github.com/ParisNeo/lollms-vs-coder) 
[![Stars](https://img.shields.io/github/stars/ParisNeo/lollms-vs-coder?style=social)](https://github.com/ParisNeo/lollms-vs-coder/stargazers) 

**Lollms VS Coder** is a powerful, AI-powered Visual Studio Code extension that brings a suite of intelligent tools directly into your editor. It leverages any Lollms-compatible API to provide advanced code assistance, autonomous agent capabilities, context-aware chat, inline autocompletion, diagram rendering, and much more.

---

## 🌟 Key Features

| Feature                  | Description                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🤖 **Autonomous Agent**      | Give the AI a complex objective, and it will generate and execute a multi-step plan, including creating files, writing code, running commands, and self-correcting.      |
| 🧠 **Smart Context**         | A sidebar file tree lets you precisely control which files and folders the AI can "see." Includes an AI-powered auto-selection tool to find relevant context for any task. |
| 💬 **Advanced AI Chat**      | An integrated chat panel that serves as your central command center for interacting with the AI, with support for file operations, script execution, and image attachments. |
| ✨ **Code Actions**          | Select any block of code and apply AI actions like "Refactor," "Explain," "Find Bugs," or create your own custom prompts directly from the editor.                    |
| ✍️ **Inline Autocomplete**   | Get single-line, "ghost text" code suggestions as you type, configurable to be automatic or manually triggered.                                                       |
| 🎨 **Diagram Rendering**     | Automatically render `SVG` and `Mermaid` diagrams directly in the chat when they are included in a code block.                                                          |
| ↔️ **Inline Diff Viewer**    | AI-suggested code changes are presented in a clear, inline diff view with one-click "Accept" and "Reject" actions.                                                      |
| 🐙 **Git Integration**       | Automatically generate conventional git commit messages based on your staged changes directly from the Source Control panel.                                          |
| 🖼️ **Image Generation**     | Generate images by describing them in the chat; the AI can also suggest image generation as part of its responses and save them directly to your project.               |
| 📓 **Jupyter Integration**   | Enhance your data science workflow with actions to "Enhance Cell" or "Generate Next Cell."                                                                              |
| 🔧 **Full Customization**    | A robust prompt management system and a dedicated settings UI allow you to tailor the AI's behavior, add new actions, and configure the extension to your needs.       |

---

## Requirements

-   A running instance of a **Lollms-compatible API**. This can be your own local [Lollms](https://github.com/ParisNeo/lollms-webui) server or any other service that exposes an OpenAI-compatible API endpoint.
-   Visual Studio Code version `1.74.0` or higher.

## 🚀 Installation & Setup

1.  Install [lollms-vs-coder](https://marketplace.visualstudio.com/items?itemName=parisneo.lollms-vs-coder) from the Visual Studio Marketplace.
2.  Open the Lollms sidebar in VS Code (click the Lollms icon in the activity bar).
3.  In the **Actions** view, click the **<span class="codicon codicon-gear"></span> Settings** item to open the configuration panel.
4.  Enter your Lollms API Host (e.g., `http://localhost:9642`) and select your desired model from the dropdown.
5.  You're ready to go! Start a new discussion from the **Discussions** view.

---

## How to Use: Core Concepts

### The AI Chat Panel
The chat panel is the central hub for interacting with Lollms. You can open it by clicking the **$(comment-discussion) Lollms Chat** button in the status bar or starting a new discussion from the sidebar. Here, you can ask questions, request code, and give high-level objectives to the AI Agent.

### Agent Mode
This is the most powerful feature of the extension. When you toggle **🤖 Agent Mode** on, you're no longer just chatting; you're giving the AI an objective to complete. The AI will:
1.  **Formulate a Plan**: It creates a step-by-step plan which is displayed in the chat window.
2.  **Execute Tasks**: It executes each task, which can include creating files, running shell commands, or generating code with sub-agents.
3.  **Self-Correct**: If a task fails (e.g., a script has an error), the agent analyzes the failure and revises its plan to fix the mistake.

### AI Context
The AI's "context" is the information it has about your project. You control this using the **AI Context Files** view in the sidebar. Click any file or folder to cycle through its three states:
-   **✅ Included**: The file's path and its full content are sent to the AI.
-   **📄 Tree-Only**: Only the file's path is included in the project tree. The content is hidden. This is the default state.
-   **🚫 Excluded**: The file or folder is completely hidden from the AI.

> **Pro Tip:** Use the **<span class="codicon codicon-wand"></span> Auto-Select Context** button in the 'Actions' view. Give the AI an objective, and it will automatically select the most relevant files to include in the context.

---

## Detailed Feature Guide

### 1. File Operations from Chat

The AI can perform various file operations by generating special code blocks. Each block comes with an interactive button to apply the action.

-   **Create/Overwrite File**: The AI provides the full file content.
    ```
    File: src/app.js
    ```
    ```javascript
    console.log('Hello, World!');
    ```
    > An **Apply to File** button will appear. Clicking it shows a diff view before saving.

-   **Apply a Patch**: The AI provides a diff to modify an existing file.
    ```
    Diff: src/app.js
    ```
    ```diff
    @@ -1,1 +1,1 @@
    -console.log('Hello, World!');
    +console.log('Hello, Lollms!');
    ```
    > An **Apply Patch** button will appear.

-   **Rename/Move Files**:
    ```
    ```rename
    src/old.js -> src/new.js
    ```
    > A **Move/Rename** button will appear.

-   **Delete Files**:
    ```
    ```delete
    temp/old-file.txt
    ```
    > A **Delete** button will appear, which prompts for confirmation.

### 2. Chat & Editor Interaction

-   **<span class="codicon codicon-play"></span> Execute Scripts**: Code blocks for `bash`, `python`, `powershell`, etc., have an **Execute** button. The script runs, and the output is fed back to the AI, which is especially useful for debugging errors.
-   **<span class="codicon codicon-search"></span> Inspect Code**: An **Inspect** button appears on AI-generated code, allowing a separate security-focused agent to check for bugs and vulnerabilities.
-   **<span class="codicon codicon-lightbulb"></span> Code Actions**: Select code in the editor, click `Lollms Actions...`, and choose a task like `Explain`, `Refactor`, `Find Bugs`, or `Generate Documentation`.
-   **<span class="codicon codicon-circuit-board"></span> Diagram Rendering**: If the AI returns a code block with the language `svg` or `mermaid`, it will be automatically rendered as a visual diagram directly in the chat.

### 3. Sidebar Views

-   **Discussions**: All your chats are saved here. You can rename, delete, and organize them into collapsible groups.
-   **AI Context Files**: Manage what the AI can see and use the toolbar to auto-select, export, save, or load context selections.
-   **Code Explorer**: Build and visualize an interactive graph of your codebase, showing file includes, function calls, and class structures.
-   **Chat Prompts & Code Actions**: Create, edit, and manage your library of custom prompts for both chat and in-editor code actions.

### 4. Git Integration

-   Click the **Lollms icon** in the Source Control panel's title bar to generate a conventional commit message based on your staged or unstaged changes.

---

## ⚙️ Configuration

Access the settings via the **Actions** view in the Lollms sidebar. Key options include:
-   **API & Model**: Set your API endpoint, key, and default model.
-   **Personas**: Customize the system prompts for the chat, agent, inspector, and commit message generator to tailor the AI's personality and responses.
-   **Agent & Inspector**: Configure the agent's self-correction retries and enable/disable the code inspector.
-   **Context & File Strategy**: Define file exclusion patterns and choose how the AI should provide file updates (`full_file` vs. `diff`).

---

## Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/ParisNeo/lollms-vs-coder/issues).

---

## License

This project is licensed under the Apache-2.0 License - see the [LICENSE](https://github.com/ParisNeo/lollms-vs-coder/blob/main/LICENSE) file for details.