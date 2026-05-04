import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const readDiscussionFileTool: ToolDefinition = {
    name: "read_discussion_file",
    description: "Reads content from files or web pages provided specifically in this chat discussion (Imported Data). Use this to access PDFs, DOCX, or web scrapes the user has shared.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "filename", type: "string", description: "The name of the file or web page to read (as seen in the 'Imported Data' list).", required: true }
    ],
    async execute(params: { filename: string }, env: ToolExecutionEnv): Promise<{ success: boolean; output: string; }> {
        if (!env.agentManager) return { success: false, output: "Agent Manager not found." };
        
        const discussion = env.agentManager.getCurrentDiscussion();
        if (!discussion) return { success: false, output: "No active discussion." };

        // Find attachments in messages
        const attachment = discussion.messages
            .filter(m => (m as any).attachmentData)
            .map(m => (m as any).attachmentData)
            .find(a => a.name === params.filename);

        if (!attachment) {
            return { success: false, output: `Could not find attachment named '${params.filename}' in this discussion.` };
        }

        return { 
            success: true, 
            output: `[CONTENT OF ATTACHED FILE: ${params.filename}]\n\n${attachment.text}` 
        };
    }
};