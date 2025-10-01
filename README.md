# Lollms VS Coder

[![Version](https://img.shields.io/github/v/release/ParisNeo/lollms-vs-coder?logo=github&style=flat-square)](https://github.com/ParisNeo/lollms-vs-coder/releases) 
[![License](https://img.shields.io/github/license/ParisNeo/lollms-vs-coder?style=flat-square)](https://github.com/ParisNeo/lollms-vs-coder/blob/main/LICENSE) 
[![Languages](https://img.shields.io/github/languages/top/ParisNeo/lollms-vs-coder?style=flat-square)](https://github.com/ParisNeo/lollms-vs-coder) 
[![Stars](https://img.shields.io/github/stars/ParisNeo/lollms-vs-coder?style=social)](https://github.com/ParisNeo/lollms-vs-coder/stargazers) 

**Lollms VS Coder** is a powerful, AI-powered Visual Studio Code extension that brings a suite of intelligent tools to your editor. It leverages any Lollms-compatible API to provide advanced code assistance, autonomous agent capabilities, context-aware chat, inline autocompletion, and much more.

---

## Key Features

-   🤖 **Autonomous Agent Mode**: Give the AI a complex objective, and it will generate and execute a multi-step plan, including creating files, writing code, running commands, and autonomously self-correcting upon failure.
-   💬 **Advanced AI Chat**: An integrated chat panel that serves as your central command center for interacting with the AI.
-   🧠 **Smart Context Management**: A sidebar file tree lets you precisely control which files and folders the AI can "see," ensuring highly relevant and accurate responses. Includes an AI-powered auto-selection tool.
-   💡 **In-Editor Code Actions**: Select any block of code and apply AI actions like "Refactor," "Explain," "Find Bugs," or your own custom prompts directly from the editor.
-   ✍️ **Inline Autocomplete**: Get single-line, "ghost text" code suggestions as you type, configurable to be automatic or manually triggered.
-   📄 **Inline Diff Viewer**: AI-suggested code changes are presented in a clear, inline diff view with one-click "Accept" and "Reject" actions.
-   🐙 **Git Integration**: Automatically generate conventional git commit messages based on your staged changes directly from the Source Control panel.
-   🎨 **Image Generation**: Generate images by describing them in the chat; the AI can also suggest image generation as part of its responses.
-   📓 **Jupyter Notebook Integration**: Enhance your data science workflow with actions to "Enhance Cell" or "Generate Next Cell."
-   🔧 **Full Customization**: A robust prompt management system and a dedicated settings UI allow you to tailor the AI's behavior, add new actions, and configure the extension to your needs.

---

## Installation

1.  Install [lollms-vs-coder](https://marketplace.visualstudio.com/items?itemName=parisneo.lollms-vs-coder) from the Visual Studio Marketplace.
2.  Open the Lollms sidebar in VS Code.
3.  Click the **gear icon (⚙️)** to open the settings panel.
4.  Enter your Lollms API Host (e.g., `http://localhost:9642`) and select your desired model.
5.  You're ready to go!

---

## Core Concepts

### The AI Chat Panel
The chat panel is the central hub for interacting with Lollms. You can open it by clicking the **$(comment-discussion) Lollms Chat** button in the status bar. Here, you can ask questions, request code, and give high-level objectives to the AI Agent.

### Agent Mode
This is the most powerful feature of the extension. When you toggle **🤖 Agent Mode** on, you're no longer just chatting; you're giving the AI an objective to complete. The AI will:
1.  **Formulate a Plan**: It creates a step-by-step plan which is displayed in the chat window.
2.  **Execute Tasks**: It executes each task, which can include creating files, running shell commands, or generating code with sub-agents.
3.  **Self-Correct**: If a task fails (e.g., a script has an error), the agent analyzes the failure and revises its plan to fix the mistake.

### AI Context
The AI's "context" is the information it has about your project. You control this using the **AI Context Files** view in the sidebar. Each file and folder can have one of three states, which you can cycle through by clicking on it:
-   **✅ Included**: The file's path and its full content are sent to the AI.
-   **📄 Tree-Only**: Only the file's path is included in the project tree. The content is hidden. This is the default state.
-   **🚫 Excluded**: The file or folder is completely hidden from the AI.

---

## Detailed Feature Guide

### 1. AI Chat Panel

-   **Working with AI Responses**:
    -   **⚙️ Apply**: For file creation or modification, an "Apply" button will appear on code blocks. This opens an inline diff view where you can accept or reject the changes.
    -   **▶️ Execute**: On shell scripts (`bash`, `python`, `powershell`, etc.), an "Execute" button lets you run the script directly. The output is fed back to the AI for analysis in case of errors.
    -   **🔍 Inspect**: Check AI-generated code for bugs and vulnerabilities. The inspector can auto-fix minor issues or provide warnings.
-   **"More Actions" Menu (...)**:
    -   **Attach Files**: Manually attach text or image files to the chat for the AI to analyze.
    -   **Set Project Entry Point**: Define the main executable file for your project.
    -   **Execute Project**: Run the project using the configured entry point. The AI will analyze the output for errors and attempt to debug them.

### 2. Sidebar Views

-   **Discussions**: All your chats are saved here. You can rename, delete, and organize them into collapsible groups.
-   **AI Context Files**: Manage what the AI can see. Use the toolbar buttons to:
    -   **Auto-Select Context (✨)**: Give the AI an objective, and it will automatically select the most relevant files to include in the context.
    -   **Export Context (📋)**: Copy the entire project context (tree + file contents) to your clipboard.
-   **Running Processes**: View any active AI tasks (like agent execution or chat generation) and cancel them if needed.
-   **Chat Prompts & Code Actions**: Create, edit, and manage your library of custom prompts for both chat and code actions.

### 3. Editor Integration

-   **Code Actions**: Select code in the editor, click the `Lollms Actions...` CodeLens, and choose a task. Default actions include:
    -   `Explain Selection`: Get an explanation of the code.
    -   `Refactor Selection`: Improve readability and performance.
    -   `Find Bugs`: Analyze for bugs and vulnerabilities.
    -   `Generate Documentation`: Add docstrings or JSDoc comments.
-   **Inline Autocomplete**: Enable in the settings for automatic "ghost text" suggestions as you type.
-   **Jupyter Notebooks**: When viewing a `.ipynb` file, new icons appear in the cell toolbar to `Enhance Cell` (refactor) or `Generate Next Cell`.

### 4. Source Control

-   Click the **Lollms icon** in the Source Control panel's title bar to generate a conventional commit message based on your staged changes.

---

## Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/ParisNeo/lollms-vs-coder/issues).

---

## License

This project is licensed under the Apache-2.0 License - see the [LICENSE](https://github.com/ParisNeo/lollms-vs-coder/blob/main/LICENSE) file for details.