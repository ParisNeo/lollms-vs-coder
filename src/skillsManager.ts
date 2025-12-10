import * as vscode from 'vscode';
import * as path from 'path';

export interface Skill {
    id: string;
    name: string;
    description: string;
    content: string;
    language?: string;
    timestamp: number;
    category?: string;
}

const LOLLMS_INSTANTIATION = `# LoLLMs Client Instantiation

The \`LollmsClient\` is the main entry point. You can configure it to use different bindings (backends) using the \`llm_binding_config\` dictionary.

## Installation

\`\`\`bash
pip install lollms-client
\`\`\`

## Examples

### LoLLMs Server (Default)
Connects to a running LoLLMs server (e.g., lollms-webui).

\`\`\`python
from lollms_client import LollmsClient

lc = LollmsClient(
    llm_binding_name="lollms", 
    llm_binding_config={
        "host_address": "http://localhost:9642",
    }
)
\`\`\`

### Ollama
Connects to a local Ollama instance.

\`\`\`python
lc = LollmsClient(
    llm_binding_name="ollama", 
    llm_binding_config={
        "model_name": "llama3",
        "host_address": "http://localhost:11434"
    }
)
\`\`\`

### OpenAI
Connects to OpenAI API.

\`\`\`python
lc = LollmsClient(
    llm_binding_name="openai",
    llm_binding_config={
        "model_name": "gpt-4o", 
        "service_key": "sk-..." 
    }
)
\`\`\`

### Anthropic Claude
\`\`\`python
lc = LollmsClient(
    llm_binding_name="openrouter", # Example using OpenRouter or specific binding if available
    llm_binding_config={
        "model_name": "claude-3-5-sonnet-20240620", 
        "service_key": "sk-ant-..." 
    }
)
\`\`\`
`;

const LOLLMS_TEXT_GENERATION = `# LoLLMs Text Generation

Generate text using \`generate_text\` or \`generate_from_messages\`.

## Basic Text Generation

\`\`\`python
from lollms_client import LollmsClient, MSG_TYPE

# Callback for streaming
def simple_callback(chunk: str, msg_type: MSG_TYPE, params=None, metadata=None) -> bool:
    if msg_type == MSG_TYPE.MSG_TYPE_CHUNK:
        print(chunk, end="", flush=True)
    return True

lc = LollmsClient(llm_binding_name="ollama", llm_binding_config={"model_name": "llama3"})

response = lc.generate_text(
    prompt="Explain quantum computing in one sentence.",
    n_predict=100,
    stream=True,
    streaming_callback=simple_callback
)
print(f"\\nResponse: {response}")
\`\`\`

## From Messages (Chat Format)

\`\`\`python
messages = [
    {"role": "system", "content": "You are a pirate."},
    {"role": "user", "content": "Hello!"}
]

response = lc.generate_from_messages(
    messages=messages,
    n_predict=200,
    stream=True
)
print(response)
\`\`\`
`;

const LOLLMS_STRUCTURED_CONTENT = `# LoLLMs Structured Content Generation

Use \`generate_structured_content\` to force the LLM to output valid JSON conforming to a specific structure.

\`\`\`python
from lollms_client import LollmsClient

lc = LollmsClient(llm_binding_name="ollama", llm_binding_config={"model_name": "llama3"})

prompt = "Generate a profile for a fantasy character named Eldrin."

# Define the expected structure instructions (or schema)
structure_instruction = """
{
    "name": "string",
    "class": "string",
    "level": "integer",
    "inventory": ["string"]
}
"""

try:
    # This helper method constructs a prompt to enforce JSON output
    # Note: Availability of this method depends on library version updates.
    # If not available directly, you can use generate_text with a system prompt enforcing JSON.
    character_json = lc.generate_structured_content(
        prompt, 
        structure_instruction
    )
    print(character_json)
except AttributeError:
    # Manual fallback
    full_prompt = f"{prompt}\\n\\nOutput valid JSON only matching this structure:\\n{structure_instruction}"
    print(lc.generate_text(full_prompt))
\`\`\`
`;

const LOLLMS_CODE_GENERATION = `# LoLLMs Code Generation

You can use the client to generate code. For advanced use cases, use an Agentic workflow (Personality) with a code interpreter MCP.

## Simple Code Generation

\`\`\`python
from lollms_client import LollmsClient

lc = LollmsClient(llm_binding_name="ollama", llm_binding_config={"model_name": "codellama"})

prompt = "Write a Python function to calculate the Fibonacci sequence recursively."
code = lc.generate_text(prompt)
print(code)
\`\`\`

## Agentic Code Generation (Conceptual)

\`\`\`python
from lollms_client import LollmsPersonality

# Define a coder personality that uses tools
coder = LollmsPersonality(
    name="Python Coder",
    system_prompt="You are a Python expert. Write code to solve the user's problem.",
    active_mcps=["python_code_interpreter"] # Assuming this MCP is available
)

# Use in a discussion (see Chat skill)
# discussion.chat("Write a script to scrape a website", personality=coder)
\`\`\`
`;

const LOLLMS_IMAGE_GENERATION = `# LoLLMs Image Generation

Use the \`diffusers\` binding or other TTI (Text-to-Image) bindings to generate images.

\`\`\`python
from lollms_client import LollmsClient

# Initialize with a TTI binding
lc = LollmsClient(
    tti_binding_name="diffusers",
    tti_binding_config={
        "model_name": "runwayml/stable-diffusion-v1-5" 
        # Or specialized models like "Qwen-Image-Edit"
    }
)

# Generate
try:
    # Returns bytes or base64 depending on configuration
    image_data = lc.generate_image("A futuristic city on Mars, cyberpunk style")
    
    with open("mars_city.png", "wb") as f:
        f.write(image_data)
    print("Image saved to mars_city.png")
except Exception as e:
    print(f"Generation failed: {e}")
\`\`\`
`;

const LOLLMS_LONG_CONTEXT = `# LoLLMs Long Context Management

The \`long_context_processing\` (or \`sequential_summarize\`) method helps process texts larger than the model's context window.

\`\`\`python
from lollms_client import LollmsClient

lc = LollmsClient(llm_binding_name="ollama", llm_binding_config={"model_name": "llama3"})

long_text = "..." # Huge text file content

summary = lc.long_context_processing(
    long_text,
    prompt="Summarize the key points of this section.",
    chunk_size=4096, # Adjust based on model context
    overlap=100
)

print(summary)
\`\`\`
`;

const LOLLMS_MCP_GENERATION = `# LoLLMs Generation with MCP (Model Context Protocol)

Enable LLMs to use external tools (MCPs) to perform actions (web search, file I/O, etc.).

\`\`\`python
from lollms_client import LollmsClient, LollmsPersonality

# 1. Define a Personality with MCPs
agent = LollmsPersonality(
    name="Research Agent",
    system_prompt="You are a researcher. Use the search tool to find information.",
    active_mcps=["google_search", "wikipedia"] # Names of available MCP tools
)

lc = LollmsClient(llm_binding_name="ollama", llm_binding_config={"model_name": "llama3"})

# 2. Interactions typically happen within a LollmsDiscussion to maintain state/observation loop
# See "LoLLMs Chat" skill for discussion setup.
\`\`\`
`;

const LOLLMS_CHAT = `# LoLLMs Chat (Discussion Management)

Use \`LollmsDiscussion\` to manage conversation history, context, and state.

\`\`\`python
from lollms_client import LollmsClient, LollmsDiscussion, LollmsDataManager
from pathlib import Path
import tempfile

# 1. Setup Database
with tempfile.TemporaryDirectory() as tmpdir:
    db_path = Path(tmpdir) / "discussion_db.sqlite"
    db_manager = LollmsDataManager(f"sqlite:///{db_path}")
    
    # 2. Setup Client
    lc = LollmsClient(llm_binding_name="ollama", llm_binding_config={"model_name": "llama3"})

    # 3. Create Discussion
    discussion = LollmsDiscussion.create_new(
        lollms_client=lc,
        db_manager=db_manager,
        id="my_chat_session",
        autosave=True
    )
    
    # 4. Chat
    response = discussion.chat(user_message="Hello! Who are you?")
    print("AI:", response['ai_message'].content)

    # 5. Multimodal Chat (Images)
    # discussion.add_message(sender="user", content="Look at this", images=[base64_img])
    # response = discussion.chat() # Processes last added message
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
        
        // Remove the old monolithic skill if it exists to avoid duplication/confusion
        const oldSkillIndex = skills.findIndex(s => s.id === 'lollms-client-lib');
        if (oldSkillIndex !== -1) {
            skills.splice(oldSkillIndex, 1);
        }

        const category = "python/lollms_client";
        const defaults = [
            { id: 'lollms-instantiation', name: 'Instantiation', desc: 'Initialize LollmsClient with different bindings.', content: LOLLMS_INSTANTIATION },
            { id: 'lollms-text-gen', name: 'Text Generation', desc: 'Basic and streaming text generation.', content: LOLLMS_TEXT_GENERATION },
            { id: 'lollms-structured', name: 'Structured Content', desc: 'Generate JSON output.', content: LOLLMS_STRUCTURED_CONTENT },
            { id: 'lollms-code-gen', name: 'Code Generation', desc: 'Generate code and simple agents.', content: LOLLMS_CODE_GENERATION },
            { id: 'lollms-image-gen', name: 'Image Generation', desc: 'Generate images using TTI bindings.', content: LOLLMS_IMAGE_GENERATION },
            { id: 'lollms-long-context', name: 'Long Context', desc: 'Process large texts.', content: LOLLMS_LONG_CONTEXT },
            { id: 'lollms-mcp', name: 'Generation with MCP', desc: 'Using Model Context Protocol tools.', content: LOLLMS_MCP_GENERATION },
            { id: 'lollms-chat', name: 'Chat', desc: 'Manage discussions and history.', content: LOLLMS_CHAT }
        ];

        let modified = false;
        for (const def of defaults) {
            if (!skills.some(s => s.id === def.id)) {
                skills.push({
                    id: def.id,
                    name: def.name,
                    description: def.desc,
                    content: def.content,
                    language: 'markdown',
                    timestamp: Date.now(),
                    category: category
                });
                modified = true;
            }
        }

        if (modified || oldSkillIndex !== -1) {
            await this.saveSkills(skills);
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
