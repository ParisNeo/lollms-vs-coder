import * as vscode from 'vscode';
import { LollmsAPI, ChatMessage } from './lollmsAPI';
import { stripThinkingTags } from './utils';

export class NotebookManager {
    constructor(private lollmsAPI: LollmsAPI) {}

    private async getNotebookContext(currentCell: vscode.NotebookCell): Promise<string> {
        const notebook = currentCell.notebook;
        let context = "";
        for (const cell of notebook.getCells()) {
            if (cell === currentCell) break; // Context up to current cell
            const content = cell.document.getText();
            if (content.length > 2000) continue; // Skip large cells to save tokens
            context += `Cell ${cell.index} (${cell.kind === vscode.NotebookCellKind.Code ? 'Code' : 'Markdown'}):\n\`\`\`\n${content}\n\`\`\`\n\n`;
        }
        return context;
    }

    private async insertCell(notebook: vscode.NotebookDocument, index: number, content: string, kind: vscode.NotebookCellKind) {
        const edit = new vscode.WorkspaceEdit();
        const cell = new vscode.NotebookCellData(kind, content, kind === vscode.NotebookCellKind.Code ? 'python' : 'markdown');
        edit.insertNotebookCells(notebook.uri, new vscode.NotebookCellEdit(index, 0, [cell]));
        await vscode.workspace.applyEdit(edit);
    }

    private async replaceCell(cell: vscode.NotebookCell, content: string) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(cell.document.uri, new vscode.Range(0, 0, cell.document.lineCount, 0), content);
        await vscode.workspace.applyEdit(edit);
    }

    private cleanResponseContent(response: string, kind: vscode.NotebookCellKind): string {
        const clean = stripThinkingTags(response);
        
        if (kind === vscode.NotebookCellKind.Code) {
            // Regex to find the first code block
            const codeBlockRegex = /```(?:python|py)?\s*([\s\S]*?)```/i;
            const match = clean.match(codeBlockRegex);
            if (match) {
                return match[1].trim();
            }
            
            // If no code block, but content has "Here is the code" or similar lines, we might want to be aggressive.
            // But for now, if no block is found, we assume the model might have returned raw code (less likely with chat models)
            // or the user prompt failed to enforce blocks.
            // Let's try to remove lines that don't look like code if it seems mixed.
            // Actually, safer to return as is if no block, user can undo.
            // BUT the user specifically complained about text + ```python.
            // If text is present, `match` WOULD have found the block if it existed.
            
            // Case: User output: "Here is code:\n```python\nprint(1)\n```" -> Match found -> returns "print(1)"
            // Case: User output: "print(1)" -> Match null -> returns "print(1)"
            
            return clean.trim();
        } else {
            // Markdown cell: Remove markdown fences if they wrap the whole content inappropriately
            // e.g. if model returns ```markdown ... ```
            const mdBlockRegex = /```markdown\s*([\s\S]*?)```/i;
            const match = clean.match(mdBlockRegex);
            if (match) return match[1].trim();
            
            // Also generic blocks if wrapping text
            if (clean.startsWith('```') && clean.endsWith('```')) {
                 const genericMatch = clean.match(/```(?:\w+)?\s*([\s\S]*?)```/);
                 if (genericMatch) return genericMatch[1].trim();
            }
            return clean.trim();
        }
    }

    async promptToNotebookCell(cell: vscode.NotebookCell) {
        const prompt = await vscode.window.showInputBox({ prompt: "Enter instructions for this cell" });
        if (!prompt) return;

        const context = await this.getNotebookContext(cell);
        const currentContent = cell.document.getText();
        
        const systemPrompt = "You are a Jupyter Notebook assistant. Generate or modify the cell content based on the user's instruction. \nCRITICAL: Return ONLY the raw code/content for the cell. Do NOT wrap the output in markdown code fences (like ```python) unless you are writing a Markdown cell that contains code. Do NOT add conversational text.";
        
        let userPrompt = `Context so far:\n${context}\n\n`;
        if (currentContent.trim()) {
            userPrompt += `Current Cell Content:\n\`\`\`\n${currentContent}\n\`\`\`\n\n`;
            userPrompt += `Instruction: Modify the current cell based on this: "${prompt}"`;
        } else {
            userPrompt += `Instruction: Generate content for this cell based on: "${prompt}"`;
        }

        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Lollms: Generating cell..." }, async () => {
            const response = await this.lollmsAPI.sendChat([{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }]);
            const content = this.cleanResponseContent(response, cell.kind);
            await this.replaceCell(cell, content);
        });
    }

    async enhanceNotebookCell(cell: vscode.NotebookCell) {
        const context = await this.getNotebookContext(cell);
        const currentContent = cell.document.getText();
        
        const systemPrompt = "You are an expert coder. Refactor and improve the following notebook cell code. \nCRITICAL: Return ONLY the raw code. Do NOT use markdown code fences. Do NOT add explanations.";
        const userPrompt = `Context:\n${context}\n\nCode to enhance:\n\`\`\`\n${currentContent}\n\`\`\``;

        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Lollms: Enhancing cell..." }, async () => {
            const response = await this.lollmsAPI.sendChat([{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }]);
            const content = this.cleanResponseContent(response, cell.kind);
            await this.replaceCell(cell, content);
        });
    }

    async generateNextNotebookCell(cell: vscode.NotebookCell) {
        const context = await this.getNotebookContext(cell);
        const currentContent = cell.document.getText();
        const fullContext = `${context}Cell ${cell.index} (Current):\n\`\`\`\n${currentContent}\n\`\`\`\n`;

        const systemPrompt = "You are a Jupyter Notebook assistant. Predict the next logical step and generate the content for the next cell. Determine if it should be code or markdown. Return the content.";
        const userPrompt = `Notebook Context:\n${fullContext}\n\nGenerate the next cell.`;

        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Lollms: Generating next cell..." }, async () => {
            const response = await this.lollmsAPI.sendChat([{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }]);
            const content = stripThinkingTags(response);
            
            // Simple heuristic to detect kind
            // If response is wrapped in ```python, it's code.
            let kind = vscode.NotebookCellKind.Markup;
            let cleanContent = content;

            const codeBlockMatch = content.match(/```(?:python|py)\s*([\s\S]*?)```/i);
            if (codeBlockMatch) {
                kind = vscode.NotebookCellKind.Code;
                cleanContent = codeBlockMatch[1].trim();
            } else if (content.includes('import ') || content.includes('def ') || content.includes('=')) {
                // If no blocks but looks like code
                kind = vscode.NotebookCellKind.Code;
                cleanContent = content.trim();
            }
            
            await this.insertCell(cell.notebook, cell.index + 1, cleanContent, kind);
        });
    }

    async explainNotebookCell(cell: vscode.NotebookCell) {
        const content = cell.document.getText();
        const systemPrompt = "Explain the following code snippet clearly and concisely in Markdown.";
        const userPrompt = `\`\`\`python\n${content}\n\`\`\``;

        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Lollms: Explaining..." }, async () => {
            const response = await this.lollmsAPI.sendChat([{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }]);
            await this.insertCell(cell.notebook, cell.index + 1, stripThinkingTags(response), vscode.NotebookCellKind.Markup);
        });
    }

    async visualizeNotebookCell(cell: vscode.NotebookCell) {
        if (cell.outputs.length === 0) {
            vscode.window.showWarningMessage("No outputs to visualize.");
            return;
        }
        
        let outputText = "";
        for (const output of cell.outputs) {
            const item = output.items.find(i => i.mime === 'text/plain' || i.mime === 'application/json');
            if (item) {
                outputText += new TextDecoder().decode(item.data) + "\n";
            }
        }

        if (!outputText) {
            vscode.window.showWarningMessage("Could not read output data (text/plain or json) to visualize.");
            return;
        }

        const code = cell.document.getText();
        const systemPrompt = "You are a data visualization expert. Generate Python code using matplotlib or seaborn to visualize the data produced by the previous cell. Return ONLY the code.";
        const userPrompt = `Previous Code:\n\`\`\`python\n${code}\n\`\`\`\n\nOutput Data Sample:\n\`\`\`\n${outputText.substring(0, 1000)}\n\`\`\`\n\nGenerate a visualization code snippet. Assume variables from the previous cell are available.`;

        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Lollms: Creating visualization..." }, async () => {
            const response = await this.lollmsAPI.sendChat([{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }]);
            const content = this.cleanResponseContent(response, vscode.NotebookCellKind.Code);
            await this.insertCell(cell.notebook, cell.index + 1, content, vscode.NotebookCellKind.Code);
        });
    }

    async analyzeNotebookCellOutput(cell: vscode.NotebookCell) {
        if (cell.outputs.length === 0) {
            vscode.window.showWarningMessage("No outputs to analyze.");
            return;
        }

        const messages: ChatMessage[] = [
            { role: 'system', content: "You are a data scientist. Analyze the outputs of the notebook cell. Provide insights, trends, or explanation of the results." }
        ];

        const contentParts: any[] = [{ type: "text", text: "Analyze the following cell output:" }];

        for (const output of cell.outputs) {
            for (const item of output.items) {
                if (item.mime.startsWith('image/')) {
                    const base64 = Buffer.from(item.data).toString('base64');
                    contentParts.push({ type: "image_url", image_url: { url: `data:${item.mime};base64,${base64}` } });
                } else if (item.mime === 'text/plain' || item.mime === 'text/markdown') {
                    const text = new TextDecoder().decode(item.data);
                    contentParts.push({ type: "text", text: `Output:\n${text}` });
                }
            }
        }

        contentParts.push({ type: "text", text: `Source Code:\n\`\`\`python\n${cell.document.getText()}\n\`\`\`` });

        messages.push({ role: 'user', content: contentParts });

        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Lollms: Analyzing output..." }, async () => {
            const response = await this.lollmsAPI.sendChat(messages);
            await this.insertCell(cell.notebook, cell.index + 1, stripThinkingTags(response), vscode.NotebookCellKind.Markup);
        });
    }

    async fixNotebookCellError(cell: vscode.NotebookCell) {
        let errorOutput = "";
        for (const output of cell.outputs) {
            const item = output.items.find(i => i.mime === 'application/vnd.code.notebook.error');
            if (item) {
                const err = JSON.parse(new TextDecoder().decode(item.data));
                errorOutput += `${err.name}: ${err.message}\n${err.stack}`;
            } else {
                const textItem = output.items.find(i => i.mime === 'text/plain');
                if (textItem) {
                    const text = new TextDecoder().decode(textItem.data);
                    if (text.toLowerCase().includes('error') || text.toLowerCase().includes('exception')) {
                        errorOutput += text;
                    }
                }
            }
        }

        if (!errorOutput) {
            vscode.window.showInformationMessage("No errors found in cell output.");
            return;
        }

        const code = cell.document.getText();
        const systemPrompt = "You are a Python debugging expert. Analyze the code and the error trace. Provide the corrected code to fix the error. Return ONLY the corrected code. Do NOT use markdown fences.";
        const userPrompt = `Code:\n\`\`\`python\n${code}\n\`\`\`\n\nError:\n\`\`\`\n${errorOutput}\n\`\`\``;

        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Lollms: Fixing error..." }, async () => {
            const response = await this.lollmsAPI.sendChat([{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }]);
            const content = this.cleanResponseContent(response, vscode.NotebookCellKind.Code);
            await this.replaceCell(cell, content);
        });
    }

    // ... generateEducativeNotebook remains same ...
    async generateEducativeNotebook(cell: vscode.NotebookCell) {
        const topic = await vscode.window.showInputBox({ prompt: "Enter the topic for the educative notebook" });
        if (!topic) return;

        const systemPrompt = `You are a technical educator. Create a mini-tutorial about "${topic}".
Generate a sequence of notebook cells (alternating Markdown and Python Code).
Separate cells with the delimiter "### CELL_SPLIT ###".
Format:
MARKDOWN
content...
### CELL_SPLIT ###
CODE
print("hello")
### CELL_SPLIT ###
...`;

        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Lollms: Generating tutorial..." }, async () => {
            const response = await this.lollmsAPI.sendChat([{ role: 'system', content: systemPrompt }, { role: 'user', content: topic }]);
            const cleanResponse = stripThinkingTags(response);
            const parts = cleanResponse.split('### CELL_SPLIT ###');
            
            const edits: vscode.NotebookCellEdit[] = [];
            let insertIndex = cell.index + 1;

            for (let part of parts) {
                part = part.trim();
                if (!part) continue;
                
                let kind = vscode.NotebookCellKind.Markup;
                let content = part;

                if (part.startsWith('CODE')) {
                    kind = vscode.NotebookCellKind.Code;
                    content = part.substring(4).trim();
                    // Clean content using our helper logic, but here we know it's a block
                    const blockMatch = content.match(/```(?:python)?\s*([\s\S]*?)```/i);
                    if (blockMatch) content = blockMatch[1].trim();
                } else if (part.startsWith('MARKDOWN')) {
                    kind = vscode.NotebookCellKind.Markup;
                    content = part.substring(8).trim();
                } else {
                    if (part.includes('def ') || part.includes('import ') || part.includes('print(')) {
                        kind = vscode.NotebookCellKind.Code;
                        content = part.replace(/^```python\n/, '').replace(/^```\n/, '').replace(/```$/, '').trim();
                    }
                }

                edits.push(new vscode.NotebookCellEdit(insertIndex++, 0, [new vscode.NotebookCellData(kind, content, kind === vscode.NotebookCellKind.Code ? 'python' : 'markdown')]));
            }

            const edit = new vscode.WorkspaceEdit();
            edit.set(cell.notebook.uri, edits);
            await vscode.workspace.applyEdit(edit);
        });
    }
}

export class LollmsNotebookCellActionProvider implements vscode.NotebookCellStatusBarItemProvider {

    provideCellStatusBarItems(cell: vscode.NotebookCell, token: vscode.CancellationToken): vscode.ProviderResult<vscode.NotebookCellStatusBarItem[]> {
        const items: vscode.NotebookCellStatusBarItem[] = [];

        // Action for prompt-based editing or generation
        const promptItem = new vscode.NotebookCellStatusBarItem(
            `$(edit) Edit/Gen`,
            vscode.NotebookCellStatusBarAlignment.Left
        );
        promptItem.command = {
            title: 'Generate or Edit with Lollms',
            command: 'lollms-vs-coder.promptToNotebookCell',
            arguments: [cell],
        };
        promptItem.tooltip = 'Generate code or edit this cell using a custom prompt';
        items.push(promptItem);

        // Action to enhance/refactor the current cell
        if (cell.document.getText().trim().length > 0) {
            const enhanceItem = new vscode.NotebookCellStatusBarItem(
                `$(sparkle) Enhance`,
                vscode.NotebookCellStatusBarAlignment.Left
            );
            enhanceItem.command = {
                title: 'Enhance Cell with Lollms',
                command: 'lollms-vs-coder.enhanceNotebookCell',
                arguments: [cell],
            };
            enhanceItem.tooltip = 'Refactor or enhance the content of this cell using AI';
            items.push(enhanceItem);
        }

        // Action to generate the next cell
        const generateNextItem = new vscode.NotebookCellStatusBarItem(
            `$(wand) Generate Next Cell`,
            vscode.NotebookCellStatusBarAlignment.Left
        );
        generateNextItem.command = {
            title: 'Generate Next Cell with Lollms',
            command: 'lollms-vs-coder.generateNextNotebookCell',
            arguments: [cell],
        };
        generateNextItem.tooltip = 'Use the content of this cell as context to generate the next code cell';
        items.push(generateNextItem);

        // NEW: Generate Educative Notebook
        const generateEducativeItem = new vscode.NotebookCellStatusBarItem(
            `$(book) Educative`,
            vscode.NotebookCellStatusBarAlignment.Left
        );
        generateEducativeItem.command = {
            title: 'Generate Educative Notebook',
            command: 'lollms-vs-coder.generateEducativeNotebook',
            arguments: [cell],
        };
        generateEducativeItem.tooltip = 'Generate a sequence of educative cells (text + code + plots) starting from this point';
        items.push(generateEducativeItem);

        // NEW: Explain Cell Action
        if (cell.document.getText().trim().length > 0 && cell.kind === vscode.NotebookCellKind.Code) {
             const explainItem = new vscode.NotebookCellStatusBarItem(
                `$(info) Explain`,
                vscode.NotebookCellStatusBarAlignment.Left
            );
            explainItem.command = {
                title: 'Explain Cell with Lollms',
                command: 'lollms-vs-coder.explainNotebookCell',
                arguments: [cell],
            };
            explainItem.tooltip = 'Generate a markdown explanation for this cell';
            items.push(explainItem);
        }

        // NEW: Visualize Data Action
        if (cell.kind === vscode.NotebookCellKind.Code && cell.outputs.length > 0) {
             const vizItem = new vscode.NotebookCellStatusBarItem(
                `$(graph) Visualize`,
                vscode.NotebookCellStatusBarAlignment.Left
            );
            vizItem.command = {
                title: 'Visualize Output with Lollms',
                command: 'lollms-vs-coder.visualizeNotebookCell',
                arguments: [cell],
            };
            vizItem.tooltip = 'Generate visualization code for this cell\'s output';
            items.push(vizItem);
        }

        // NEW: Analyze Output Action
        if (cell.outputs.length > 0) {
             const analyzeItem = new vscode.NotebookCellStatusBarItem(
                `$(beaker) Analyze Output`,
                vscode.NotebookCellStatusBarAlignment.Left
            );
            analyzeItem.command = {
                title: 'Analyze Output with Lollms',
                command: 'lollms-vs-coder.analyzeNotebookCellOutput',
                arguments: [cell],
            };
            analyzeItem.tooltip = 'Analyze the output of this cell using AI';
            items.push(analyzeItem);
        }

        // NEW: Fix Error Action (Visible only on failure)
        if (cell.executionSummary && cell.executionSummary.success === false) {
            const fixErrorItem = new vscode.NotebookCellStatusBarItem(
                `$(debug-restart) Fix with Lollms`,
                vscode.NotebookCellStatusBarAlignment.Right
            );
            fixErrorItem.command = {
                title: 'Fix Cell Error with Lollms',
                command: 'lollms-vs-coder.fixNotebookCellError',
                arguments: [cell],
            };
            fixErrorItem.tooltip = 'Analyze the error trace and auto-correct the cell code';
            fixErrorItem.priority = 200; // High priority to be visible on the right
            items.push(fixErrorItem);
        }

        return items;
    }
}
