import * as vscode from 'vscode';
import { LollmsServices } from '../lollmsContext';
import { EducativeNotebookModal } from '../commands/educativeNotebookModal';
import { ChatMessage } from '../lollmsAPI';
import { stripThinkingTags } from '../utils';

export function registerNotebookCommands(context: vscode.ExtensionContext, services: LollmsServices) {
    
    // Cell Action Commands (triggered from Cell Status Bar)
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.promptToNotebookCell', async (cell: vscode.NotebookCell) => {
        await services.notebookManager.promptToNotebookCell(cell);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.enhanceNotebookCell', async (cell: vscode.NotebookCell) => {
        await services.notebookManager.enhanceNotebookCell(cell);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.generateNextNotebookCell', async (cell: vscode.NotebookCell) => {
        await services.notebookManager.generateNextNotebookCell(cell);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.explainNotebookCell', async (cell: vscode.NotebookCell) => {
        await services.notebookManager.explainNotebookCell(cell);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.visualizeNotebookCell', async (cell: vscode.NotebookCell) => {
        await services.notebookManager.visualizeNotebookCell(cell);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.analyzeNotebookCellOutput', async (cell: vscode.NotebookCell) => {
        await services.notebookManager.analyzeNotebookCellOutput(cell);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.fixNotebookCellError', async (cell: vscode.NotebookCell) => {
        await services.notebookManager.fixNotebookCellError(cell);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.generateEducativeNotebook', async (cell: vscode.NotebookCell) => {
        await services.notebookManager.generateEducativeNotebook(cell);
    }));

    // Notebook Generation Command (from Actions View)
    context.subscriptions.push(vscode.commands.registerCommand('lollms-vs-coder.generateEducativeNotebookFromAction', async () => {
        const result = await EducativeNotebookModal.createOrShow(services.extensionUri);
        
        if (result) {
            const { topic, includeTree, selectedTools } = result;

            if (!vscode.workspace.workspaceFolders) {
                vscode.window.showErrorMessage("Please open a workspace to generate a notebook.");
                return;
            }
            
            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri;
            
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Generating Notebook: ${topic}`,
                cancellable: true
            }, async (progress, token) => {
                
                try {
                    let contextText = "";
                    if (includeTree) {
                        const contextContent = await services.contextManager.getContextContent({ includeTree: true });
                        contextText = contextContent.text;
                    }

                    const systemPrompt = `You are a technical educator creating a Jupyter Notebook.
Topic: "${topic}"
Tools Enabled: ${selectedTools.join(', ')}

**Instructions:**
1. Create a structured notebook with alternating Markdown (explanations) and Python Code cells.
2. Use valid JSON format for the notebook structure.
3. Content should be educational, clear, and executable.
4. If project context is provided, reference it where relevant.

**Output Format:**
Return ONLY the raw JSON string of the .ipynb file. Do not wrap it in markdown code blocks.
`;
                    const userPrompt = `Generate the notebook JSON.\n\nContext:\n${contextText}`;
                    
                    const response = await services.lollmsAPI.sendChat([
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ]);

                    let jsonContent = stripThinkingTags(response);
                    // Attempt to clean markdown fences if present
                    const match = jsonContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
                    if (match) {
                        jsonContent = match[1];
                    }

                    // Validate JSON
                    try {
                        JSON.parse(jsonContent);
                    } catch (e) {
                        throw new Error("AI generated invalid JSON for the notebook.");
                    }

                    // Create file
                    const filename = `educative_notebook_${Date.now()}.ipynb`;
                    const uri = vscode.Uri.joinPath(workspaceRoot, filename);
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(jsonContent, 'utf8'));
                    
                    const doc = await vscode.workspace.openNotebookDocument(uri);
                    await vscode.window.showNotebookDocument(doc);
                    
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to generate notebook: ${error.message}`);
                }
            });
        }
    }));
}
