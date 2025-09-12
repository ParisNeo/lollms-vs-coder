# lollms-vs-coder (under construction, still not stable enough)

[![Version](https://img.shields.io/github/v/release/ParisNeo/lollms-vs-coder?logo=github&style=flat-square)](https://github.com/ParisNeo/lollms-vs-coder/releases) 
[![License](https://img.shields.io/github/license/ParisNeo/lollms-vs-coder?style=flat-square)](https://github.com/ParisNeo/lollms-vs-coder/blob/main/LICENSE) 
[![Languages](https://img.shields.io/github/languages/top/ParisNeo/lollms-vs-coder?style=flat-square)](https://github.com/ParisNeo/lollms-vs-coder) 
[![Stars](https://img.shields.io/github/stars/ParisNeo/lollms-vs-coder?style=social)](https://github.com/ParisNeo/lollms-vs-coder/stargazers) 

Lollms-vs-coder is an AI-powered Visual Studio Code extension leveraging a Lollms-compatible API for advanced code assistance, inline autocompletion, context management, and automated git commit message generation.

---

## Features

- **Conversational AI Chat:** An integrated chat panel for coding assistance and debugging, with full discussion history management.
- **AI-Powered Code Actions:** Select code and apply AI actions like "Refactor", "Explain", or "Find Bugs" directly from the editor.
- **Inline Autocomplete:** Get single-line, "ghost text" code suggestions as you type (optional) or trigger them manually with a status bar button.
- **Smart Context Management:** A sidebar file tree lets you control which files are included in the AI's context for more accurate and relevant responses.
- **Customizable Prompts:** Comes with a set of useful, protected default prompts and allows you to create, edit, and organize your own.
- **Git Integration:** Auto-generate conventional git commit messages based on your staged changes.
- **Configurable:** Easily configure the API host, key, and model from the settings UI.

---

## Installation

Install [lollms-vs-coder](https://marketplace.visualstudio.com/) directly from the Visual Studio Marketplace or build from source:

```
git clone https://github.com/ParisNeo/lollms-vs-coder.git
cd lollms-vs-coder
npm install
npm run compile
code .
```

Use the VS Code Extension Development Host to launch and test.

---

## Configuration

Configure the Lollms API connection via the sidebar or by manually editing your VS Code settings. The most important settings are:

```
{
  "lollmsVsCoder.apiUrl": "http://localhost:9642",
  "lollmsVsCoder.apiKey": "<YOUR_LOLLMS_API_KEY>",
  "lollmsVsCoder.modelName": "<YOUR_MODEL_NAME>",
  "lollmsVsCoder.enableInlineSuggestions": false // Set to true to enable automatic ghost-text suggestions
}
```

---

## Usage

- **Start Chat:** Click the **$(comment-discussion) Lollms Chat** button in the status bar.
- **Use Code Actions:** Select code, and a **Lollms Actions...** link will appear above it.
- **Manual Autocomplete:** Click the **$(sparkle) Lollms** button in the status bar to get a single-line completion.
- **Manage Context:** Use the **AI Context Files** view in the Lollms sidebar to control which files the AI can see.
- **Generate Commit Messages:** Click the sparkle icon in the Source Control panel's title bar.
- **Get Help:** Open the command palette and run `Lollms: Show Help`.

---

## Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/ParisNeo/lollms-vs-coder/issues).

---

## License

This project is licensed under the Apache-2.0 License - see the [LICENSE](https://github.com/ParisNeo/lollms-vs-coder/blob/main/LICENSE) file for details.

---

*Made with 💙 using Lollms and VS Code APIs.*
