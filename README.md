# lollms-vs-coder

[![Version](https://img.shields.io/github/v/release/ParisNeo/lollms-vs-coder?logo=github&style=flat-square)](https://github.com/ParisNeo/lollms-vs-coder/releases) 
[![License](https://img.shields.io/github/license/ParisNeo/lollms-vs-coder?style=flat-square)](https://github.com/ParisNeo/lollms-vs-coder/blob/main/LICENSE) 
[![Languages](https://img.shields.io/github/languages/top/ParisNeo/lollms-vs-coder?style=flat-square)](https://github.com/ParisNeo/lollms-vs-coder) 
[![Stars](https://img.shields.io/github/stars/ParisNeo/lollms-vs-coder?style=social)](https://github.com/ParisNeo/lollms-vs-coder/stargazers) 

Lollms-vs-coder is an AI-powered Visual Studio Code extension leveraging Lollms's OpenAI-compatible interface for advanced code assistance, debugging, real-time enhancements, context management, and automated git commit message generation with full versioning support.

---

## Features

- Conversational AI chat interface integrated into VS Code for coding assistance and debugging.
- Real-time code enhancement, generation from comments, and smart autocompletion.
- Add or remove files from AI context for precise and efficient prompt crafting.
- Auto-generate conventional git commit messages based on staged code changes.
- Full versioning support: AI-assisted changes are tracked via Git commits.
- Configurable API host and key with an easy-access UI on the sidebar.
- Lightweight, fast, and customizable to fit your AI coding workflow.

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

Configure the Lollms API connection via the sidebar **Lollms Settings** panel or by manually editing your VS Code settings:

```
{
  "lollmsVsCoder.apiKey": "<YOUR_LOLLMS_API_KEY>",
  "lollmsVsCoder.apiHost": "http://localhost:9642"
}
```

---

## Usage

- Use the **Lollms: Start Chat** command or the status bar button to open the AI chat panel.
- Add or remove active files from AI context via command palette commands:
  - `Lollms: Add File to AI Context`
  - `Lollms: Remove File from AI Context`
- Generate AI-suggested commit messages:
  - `Lollms: Generate Git Commit Message`
  - `Lollms: Commit Staged Changes with AI Message`

---

## Contributing

Contributions, issues, and feature requests are welcome! Feel free to check [issues page](https://github.com/ParisNeo/lollms-vs-coder/issues) if you want to contribute.

---

## License

This project is licensed under the Apache-2.0 License - see the [LICENSE](https://github.com/ParisNeo/lollms-vs-coder/blob/main/LICENSE) file for details.

---

## Links & Resources

- [Lollms GitHub](https://github.com/ParisNeo/lollms) - For Lollms API and backend info
- [VS Code Extension API](https://code.visualstudio.com/api) - Official docs and guidelines

---

*Made with 💙 using Lollms and VS Code APIs.*
