# Changelog

All notable changes to the "Lollms VS Coder" extension will be documented in this file.

## [0.3.6] - 2025-09-24

### ✨ Features

-   **Added Code Inspector**: A new "Inspect" button (🔍) appears on AI-generated code blocks.
-   **Security Analysis**: The inspector checks code for bugs, errors, vulnerabilities, and malicious content.
-   **Intelligent Feedback**: The inspector provides clear feedback: "OK" for safe code, automatic fixes for minor bugs, and detailed warnings for serious vulnerabilities or malicious code.
-   **Configurable Inspector**: New settings allow you to enable/disable the inspector, specify a separate model for security checks, and customize the inspection system prompt.

### 🐛 Bug Fixes & Polish

-   **Fixed**: The AI Agent now receives the user's OS (`win32`, `linux`, etc.) in its system prompt and is strictly instructed to generate OS-compatible scripts, preventing cross-platform errors.
-   **Improved**: The chat panel now adds an "Execute" button to Windows Batch (`.bat`, `.cmd`) code blocks.

## [0.3.5] - 2025-09-24

### 🐛 Bug Fixes & Polish

-   **Fixed**: Scripts executed from the chat panel now run from a temporary folder (`.lollms/temp_scripts`) within the workspace root, ensuring the correct working directory and preventing "No such file or directory" errors.
-   **Changed**: Replaced the "Generate Commit Message" text button in the Source Control panel with the Lollms icon for a cleaner UI.
-   **Improved**: Enhanced the system prompt for git commit message generation with stricter instructions to ensure more reliable and correctly formatted output, especially from smaller language models.

## [0.3.4] - 2025-09-24

### ✨ Features

-   **Added**: An **Execute** button (▶️) now appears on shell script code blocks (`bash`, `shell`, `sh`, `powershell`, `cmd`, `bat`) in the chat, allowing for direct execution.
-   **Added**: The script runner now supports PowerShell and Windows Batch/CMD scripts.
-   **Added**: The AI Agent can now use a `set_launch_entrypoint` action to programmatically set the main executable file in the project's `.vscode/launch.json`.
-   **Added**: The AI Agent can now use the `auto_select_context_files` action to intelligently select and add relevant files to its own context based on a sub-objective.

## [0.3.3] - 2025-09-24

### ✨ Features

-   **Added**: A new **Execute Project** button (▶️) has been added to the chat input area, allowing users to run the project using the active VS Code launch configuration.
-   **Added**: The extension now automatically analyzes the output of an executed project. If the exit code is non-zero, it prompts the AI to analyze the error and suggest a fix.
-   **Improved**: The "Auto-Select Context Files" command now seamlessly transitions into a new chat discussion, sending the user's objective to the AI with the newly selected files already in context.

## [0.3.2] - 2025-09-23

### ✨ Features & UI/UX Improvements

-   **Added**: A "Show Log" button (📜) now appears on assistant messages, allowing users to view the raw API request and response for debugging.
-   **Added**: A "Save as Prompt" button (💾) has been added to assistant messages for easily saving useful AI responses.
-   **Improved**: The sidebar view order has been reorganized to **Discussions**, **AI Context Files**, and then **Prompts**.
-   **Improved**: Prompt groups in the sidebar are now collapsed by default for a cleaner initial view.
-   **Improved**: Discussion title generation is now more robust, instructing the AI to return a JSON object to prevent it from answering the prompt directly.

## [0.3.0] - Agent Mode

### ✨ Features

-   **Introduced Agent Mode**: A powerful new mode where the AI can create and execute multi-step plans to achieve complex objectives.
-   **Execution Plan View**: The agent's plan is displayed dynamically in the chat, showing the status of each task (Pending, In Progress, Completed, Failed).
-   **Autonomous Self-Correction**: The agent can now analyze failures, revise its plan, and retry tasks without user intervention.
-   **User Intervention**: If the agent fails to self-correct, it will pause and ask the user for guidance (Stop, Continue, or View Log).

## [0.2.5] - Git Integration & Inline Suggestions

### ✨ Features

-   **Git Integration**: Added the ability to generate conventional commit messages based on staged or unstaged changes directly from the Source Control panel.
-   **Inline Autocomplete**: Introduced an experimental "ghost text" inline suggestion feature that provides single-line code completions as you type.
-   **Help Panel**: Added a comprehensive help panel accessible from the sidebar.
-   **Status Bar UI**: Added status bar items for quick access to starting a chat and selecting a model.

## [0.2.0] - Advanced Code Actions & Prompts

### ✨ Features

-   **Prompt Management**: Implemented a robust system for managing custom prompts, which are stored in a JSON file in the extension's global storage.
-   **AI-Powered Code Actions**: Added a "Lollms Actions..." CodeLens that appears over selected code, allowing users to apply AI actions like "Refactor", "Explain", and "Find Bugs".
-   **Inline Diff Viewer**: Code modification actions now present their suggestions in an inline diff view, with "Accept" and "Reject" options.
-   **Custom Action Modal**: Users can now create one-time custom prompts for code actions through a dedicated modal.
-   **Sidebar Prompt Views**: Added "Chat Prompts" and "Code Actions" tree views to the sidebar for organizing and accessing custom prompts.

## [0.1.0] - Initial Release

### ✨ Features

-   **Core Chat Functionality**: An integrated webview panel for conversational AI chat.
-   **Lollms API Integration**: Connects to any Lollms-compatible API for model inference.
-   **Settings Panel**: A dedicated UI for configuring the API URL, key, and model name.
-   **Discussion Management**: Chat sessions are saved as "Discussions" and can be viewed, reopened, and deleted from the sidebar.
-   **AI Context Management**: A file tree view in the sidebar allows users to manually select files and folders to be included in the AI's context.