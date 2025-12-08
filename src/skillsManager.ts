import * as vscode from 'vscode';
import * as path from 'path';

export interface Skill {
    id: string;
    name: string;
    description: string;
    content: string;
    language?: string;
    timestamp: number;
}

const LOLLMS_CLIENT_DOCS = `# LoLLMs Client Library

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![PyPI version](https://badge.fury.io/py/lollms_client.svg)](https://badge.fury.io/py/lollms_client)
[![Python Versions](https://img.shields.io/pypi/pyversions/lollms_client.svg)](https://pypi.org/project/lollms-client/)
[![Downloads](https://static.pepy.tech/personalized-badge/lollms-client?period=total&units=international_system&left_color=grey&right_color=green&left_text=Downloads)](https://pepy.tech/project/lollms-client)

**\`lollms_client\`** is a powerful and flexible Python library designed to simplify interactions with the **LoLLMs (Lord of Large Language Models)** ecosystem and various other Large Language Model (LLM) backends. It provides a unified API for text generation, multimodal operations (text-to-image, text-to-speech, etc.), and robust function calling through the Model Context Protocol (MCP).

Whether you're connecting to a remote LoLLMs server, an Ollama instance, the OpenAI API, or running models locally using GGUF (via \`llama-cpp-python\` or a managed \`llama.cpp\` server), Hugging Face Transformers, or vLLM, \`lollms-client\` offers a consistent and developer-friendly experience.

## Key Features

*   🔌 **Versatile Binding System:** Seamlessly switch between different LLM backends (LoLLMs, Ollama, OpenAI, Llama.cpp, Transformers, vLLM, OpenLLM, Gemini, Claude, Groq, OpenRouter, Hugging Face Inference API) using a unified \`llm_binding_config\` dictionary for all parameters.
*   🗣️ **Comprehensive Multimodal Support:** Interact with models capable of processing images and generate various outputs like speech (TTS), video (TTV), and music (TTM).
*   🎨 **Advanced Image Generation and Editing:** A new \`diffusers\` binding provides powerful text-to-image capabilities. It supports a wide range of models from Hugging Face and Civitai, including specialized models like \`Qwen-Image-Edit\` for single-image editing and the cutting-edge \`Qwen-Image-Edit-2509\` for **multi-image fusion, pose transfer, and character swapping**.
*   🖼️ **Selective Image Activation:** Control which images in a message are active and sent to the model, allowing for fine-grained multimodal context management without deleting the original data.
*   🤖 **Agentic Workflows with MCP:** Empower LLMs to act as sophisticated agents, breaking down complex tasks, selecting and executing external tools (e.g., internet search, code interpreter, file I/O, image generation) through the Model Context Protocol (MCP) using a robust "observe-think-act" loop.
*   🎭 **Personalities as Agents:** Personalities can now define their own set of required tools (MCPs) and have access to static or dynamic knowledge bases (\`data_source\`), turning them into self-contained, ready-to-use agents.
*   🚀 **Streaming & Callbacks:** Efficiently handle real-time text generation with customizable callback functions across all generation methods, including during agentic (MCP) interactions.
*   📑 **Long Context Processing:** The \`long_context_processing\` method (formerly \`sequential_summarize\`) intelligently chunks and synthesizes texts that exceed the model's context window, suitable for summarization or deep analysis.
*   📝 **Advanced Structured Content Generation:** Reliably generate structured JSON output from natural language prompts using the \`generate_structured_content\` helper method, enforcing a specific schema.
*   💬 **Advanced Discussion Management:** Robustly manage conversation histories with \`LollmsDiscussion\`, featuring branching, context exporting, and automatic pruning.
*   🧠 **Persistent Memory & Data Zones:** \`LollmsDiscussion\` now supports multiple, distinct data zones (\`user_data_zone\`, \`discussion_data_zone\`, \`personality_data_zone\`) and a long-term \`memory\` field. This allows for sophisticated context layering and state management, enabling agents to learn and remember over time.
*   ✍️ **Structured Memorization:** The \`memorize()\` method analyzes a conversation to extract its essence (e.g., a problem and its solution), creating a structured "memory" with a title and content. These memories are stored and can be explicitly loaded into the AI's context, providing a more robust and manageable long-term memory system.
*   📊 **Detailed Context Analysis:** The \`get_context_status()\` method provides a rich, detailed breakdown of the prompt context, showing the content and token count for each individual component (system prompt, data zones, message history).
*   ⚙️ **Standardized Configuration Management:** A unified dictionary-based system (\`llm_binding_config\`) to configure any binding in a consistent manner.
*   🧩 **Extensible:** Designed to easily incorporate new LLM backends and modality services, including custom MCP toolsets.
*   📝 **High-Level Operations:** Includes convenience methods for complex tasks like sequential summarization and deep text analysis directly within \`LollmsClient\`.

## Installation

You can install \`lollms_client\` directly from PyPI:

\`\`\`bash
pip install lollms-client
\`\`\`

## Core Generation Methods

### Basic Text Generation (\`generate_text\`)

\`\`\`python
from lollms_client import LollmsClient, MSG_TYPE
from ascii_colors import ASCIIColors
import os

# Callback for streaming output
def simple_streaming_callback(chunk: str, msg_type: MSG_TYPE, params=None, metadata=None) -> bool:
    if msg_type == MSG_TYPE.MSG_TYPE_CHUNK:
        print(chunk, end="", flush=True)
    return True # True to continue streaming

try:
    # Initialize client to connect to a LoLLMs server.
    lc = LollmsClient(
        llm_binding_name="lollms", 
        llm_binding_config={
            "host_address": "http://localhost:9642",
        }
    )

    prompt = "Tell me a fun fact about space."
    response_text = lc.generate_text(
        prompt,
        n_predict=100,
        stream=True,
        streaming_callback=simple_streaming_callback
    )
except Exception as e:
    ASCIIColors.error(f"An unexpected error occurred: {e}")
\`\`\`

### Generating from Message Lists (\`generate_from_messages\`)

\`\`\`python
from lollms_client import LollmsClient, MSG_TYPE
import os

try:
    lc = LollmsClient(
        llm_binding_name="ollama", 
        llm_binding_config={
            "model_name": "llama3",
            "host_address": "http://localhost:11434"
        }
    )

    messages = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello!"}
    ]

    response_text = lc.generate_from_messages(
        messages=messages,
        n_predict=200,
        stream=True
    )
except Exception as e:
    print(f"Error: {e}")
\`\`\`

## Advanced Discussion Management

### Basic Chat with \`LollmsDiscussion\`

\`\`\`python
from lollms_client import LollmsClient, LollmsDiscussion, MSG_TYPE, LollmsDataManager
from pathlib import Path
import tempfile

with tempfile.TemporaryDirectory() as tmpdir:
    db_path = Path(tmpdir) / "discussion_db.sqlite"
    db_manager = LollmsDataManager(f"sqlite:///{db_path}")
    
    lc = LollmsClient(llm_binding_name="ollama", llm_binding_config={"model_name": "llama3"})

    discussion = LollmsDiscussion.create_new(
        lollms_client=lc,
        db_manager=db_manager,
        id="basic_chat_example",
        autosave=True
    )
    
    response = discussion.chat(user_message="Hello, how are you?")
    print(response['ai_message'].content)
\`\`\`

### Managing Multimodal Context: Activating and Deactivating Images

When working with multimodal models, you can control which images in a message are active.

\`\`\`python
# ... setup discussion ...
discussion.add_message(
    sender="user", 
    content="What is in the image?", 
    images=[img1_b64, img2_b64]
)
user_message = discussion.get_messages()[-1]

# Deactivate irrelevant images
user_message.toggle_image_activation(index=0, active=False)
discussion.commit()
\`\`\`

### Agentic Workflows

Example of a Python Coder Agent using \`LollmsPersonality\`:

\`\`\`python
from lollms_client import LollmsClient, LollmsPersonality, LollmsDiscussion

coder_personality = LollmsPersonality(
    name="Python Coder Agent",
    author="lollms-client",
    category="Coding",
    description="An agent that writes and executes Python code.",
    system_prompt="You are an expert Python programmer. Use the python_code_interpreter tool.",
    active_mcps=["python_code_interpreter"]
)

lc = LollmsClient(
    llm_binding_name="ollama",          
    llm_binding_config={"model_name": "codellama"},
    mcp_binding_name="local_mcp" 
)

# ... setup discussion ...
response = discussion.chat(
    user_message="Write a Python function to sum two numbers.",
    personality=coder_personality,
    max_llm_iterations=5
)
\`\`\`

## Using LoLLMs Client with Different Bindings

You can configure different backends using \`llm_binding_config\`:

**LoLLMs Server:**
\`\`\`python
config = { "host_address": "http://localhost:9642" }
\`\`\`

**Ollama:**
\`\`\`python
config = { "model_name": "llama3", "host_address": "http://localhost:11434" }
\`\`\`

**OpenAI:**
\`\`\`python
config = { "model_name": "gpt-4o", "service_key": "sk-..." }
\`\`\`

**Anthropic Claude:**
\`\`\`python
config = { "model_name": "claude-3-5-sonnet-20240620", "service_key": "sk-ant-..." }
\`\`\`

**Diffusers (Local Image Gen):**
\`\`\`python
lc = LollmsClient(
    tti_binding_name="diffusers",
    tti_binding_config={
        "model_name": "runwayml/stable-diffusion-v1-5"
    }
)
image_bytes = lc.generate_image("Astronaut on Mars")
\`\`\`
`;

export class SkillsManager {
    private skillsFile!: vscode.Uri;

    constructor() {}

    public async switchWorkspace(workspaceRoot: vscode.Uri) {
        const lollmsDir = vscode.Uri.joinPath(workspaceRoot, '.lollms');
        this.skillsFile = vscode.Uri.joinPath(lollmsDir, 'skills.json');
        await this.initialize(lollmsDir);
    }

    private async initialize(lollmsDir: vscode.Uri) {
        try {
            await vscode.workspace.fs.createDirectory(lollmsDir);
        } catch (e) {
            // Directory likely already exists
        }
        try {
            await vscode.workspace.fs.stat(this.skillsFile);
        } catch {
            // File doesn't exist, create it with an empty array
            await this.saveSkills([]);
        }
        
        // Ensure default skills are present
        await this.ensureDefaultSkills();
    }

    private async ensureDefaultSkills() {
        const skills = await this.getSkills();
        const defaultSkillId = 'lollms-client-lib';
        
        const defaultSkill: Skill = {
            id: defaultSkillId,
            name: 'LoLLMs Client Library',
            description: 'Comprehensive documentation for the lollms_client Python library.',
            content: LOLLMS_CLIENT_DOCS,
            language: 'markdown',
            timestamp: Date.now() // Always update timestamp to keep it relevant? Or keep old? 
                                  // Let's rely on existence check.
        };

        if (!skills.some(s => s.id === defaultSkillId)) {
            skills.push(defaultSkill);
            await this.saveSkills(skills);
        } else {
            // Optional: Update the content if it already exists to ensure latest docs
            // Uncomment the lines below if you want to force update the docs on reload
            /*
            const index = skills.findIndex(s => s.id === defaultSkillId);
            if (index !== -1) {
                skills[index].content = LOLLMS_CLIENT_DOCS;
                await this.saveSkills(skills);
            }
            */
        }
    }

    public async getSkills(): Promise<Skill[]> {
        if (!this.skillsFile) return [];
        try {
            const content = await vscode.workspace.fs.readFile(this.skillsFile);
            const skills = JSON.parse(content.toString());
            return Array.isArray(skills) ? skills.sort((a, b) => b.timestamp - a.timestamp) : [];
        } catch (error) {
            console.error("Error reading skills file:", error);
            return [];
        }
    }

    public async saveSkills(skills: Skill[]): Promise<void> {
        if (!this.skillsFile) return;
        const content = Buffer.from(JSON.stringify(skills, null, 2), 'utf8');
        await vscode.workspace.fs.writeFile(this.skillsFile, content);
    }

    public async addSkill(skillData: Omit<Skill, 'id' | 'timestamp'>): Promise<Skill> {
        const skills = await this.getSkills();
        const newSkill: Skill = {
            ...skillData,
            id: Date.now().toString() + Math.random().toString(36).substring(2),
            timestamp: Date.now()
        };
        skills.push(newSkill);
        await this.saveSkills(skills);
        return newSkill;
    }

    public async deleteSkill(skillId: string): Promise<void> {
        let skills = await this.getSkills();
        skills = skills.filter(s => s.id !== skillId);
        await this.saveSkills(skills);
    }

    // New: Export skills to a JSON file
    public async exportSkills() {
        const skills = await this.getSkills();
        if (skills.length === 0) {
            vscode.window.showInformationMessage("No skills to export.");
            return;
        }

        const fileUri = await vscode.window.showSaveDialog({
            title: "Export Skills",
            filters: { "JSON": ["json"] },
            defaultUri: vscode.Uri.file("skills_export.json")
        });

        if (fileUri) {
            const content = Buffer.from(JSON.stringify(skills, null, 2), 'utf8');
            await vscode.workspace.fs.writeFile(fileUri, content);
            vscode.window.showInformationMessage(`Successfully exported ${skills.length} skills.`);
        }
    }

    // New: Import skills from a JSON file
    public async importSkills() {
        const fileUris = await vscode.window.showOpenDialog({
            title: "Import Skills",
            filters: { "JSON": ["json"] },
            canSelectMany: false
        });

        if (!fileUris || fileUris.length === 0) return;

        try {
            const content = await vscode.workspace.fs.readFile(fileUris[0]);
            const importedSkills = JSON.parse(content.toString());

            if (!Array.isArray(importedSkills)) {
                throw new Error("Invalid format: expected an array of skills.");
            }

            const currentSkills = await this.getSkills();
            let addedCount = 0;

            for (const skill of importedSkills) {
                if (skill.name && skill.content) {
                    // Generate new ID to avoid collisions
                    skill.id = Date.now().toString() + Math.random().toString(36).substring(2);
                    skill.timestamp = Date.now();
                    currentSkills.push(skill);
                    addedCount++;
                }
            }

            await this.saveSkills(currentSkills);
            vscode.window.showInformationMessage(`Successfully imported ${addedCount} skills.`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to import skills: ${error.message}`);
        }
    }
}
