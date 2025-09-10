import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { ChatPanel } from './commands/chatPanel';

interface PythonExtension {
    settings: {
        getExecutionDetails(resource?: vscode.Uri): {
            execCommand: string[];
        };
    };
}

export class ScriptRunner {

    constructor() {}

    public async runScript(code: string, language: string, chatPanel: ChatPanel): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage("Please open a workspace to run scripts.");
            return;
        }

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Lollms: Running ${language} script...`,
            cancellable: false
        }, async (progress) => {
            let command: string;
            let tempFilePath: string | undefined;

            try {
                switch (language) {
                    case 'python':
                        const pythonPath = await this.getPythonInterpreterPath(workspaceFolder.uri);
                        tempFilePath = await this.createTempFile(workspaceFolder, 'script.py', code);
                        command = `${pythonPath} "${tempFilePath}"`;
                        break;
                    case 'javascript':
                        tempFilePath = await this.createTempFile(workspaceFolder, 'script.js', code);
                        command = `node "${tempFilePath}"`;
                        break;
                    case 'typescript':
                        tempFilePath = await this.createTempFile(workspaceFolder, 'script.ts', code);
                        command = `npx ts-node "${tempFilePath}"`;
                        break;
                    case 'bash':
                    case 'sh':
                    case 'shell':
                        command = code; // Execute directly
                        break;
                    default:
                        vscode.window.showWarningMessage(`Running scripts for language '${language}' is not supported.`);
                        return;
                }

                const output = await this.executeCommand(command, workspaceFolder.uri.fsPath);
                
                const formattedOutput = `
**Script Execution Result:**
\`\`\`text
${output.trim()}
\`\`\`
`;
                await chatPanel.addMessageToDiscussion({ role: 'system', content: formattedOutput });

            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const formattedError = `
**Script Execution Failed:**
\`\`\`text
${errorMessage.trim()}
\`\`\`
`;
                await chatPanel.addMessageToDiscussion({ role: 'system', content: formattedError });
            } finally {
                if (tempFilePath) {
                    await this.deleteTempFile(tempFilePath);
                }
            }
        });
    }

    private async getPythonInterpreterPath(resource?: vscode.Uri): Promise<string> {
        try {
            const pythonExtension = vscode.extensions.getExtension<PythonExtension>('ms-python.python');
            if (!pythonExtension) {
                vscode.window.showWarningMessage("Python extension not found. Using 'python' from system PATH.");
                return 'python';
            }
            if (!pythonExtension.isActive) {
                await pythonExtension.activate();
            }
            const execDetails = pythonExtension.exports.settings.getExecutionDetails(resource);
            return execDetails.execCommand[0] || 'python';
        } catch (error) {
            console.error("Failed to get Python interpreter from extension:", error);
            vscode.window.showWarningMessage("Could not determine Python interpreter. Using 'python' from system PATH.");
            return 'python';
        }
    }

    private async createTempFile(workspaceFolder: vscode.WorkspaceFolder, fileName: string, content: string): Promise<string> {
        const tempDir = path.join(workspaceFolder.uri.fsPath, '.vscode', '.lollms', 'temp');
        if (!fs.existsSync(tempDir)) {
            await fs.promises.mkdir(tempDir, { recursive: true });
        }
        const tempFilePath = path.join(tempDir, `${Date.now()}_${fileName}`);
        await fs.promises.writeFile(tempFilePath, content);
        return tempFilePath;
    }

    private async deleteTempFile(filePath: string): Promise<void> {
        try {
            if (fs.existsSync(filePath)) {
                await fs.promises.unlink(filePath);
            }
        } catch (error) {
            console.error(`Failed to delete temporary file ${filePath}:`, error);
        }
    }

    private executeCommand(command: string, cwd: string): Promise<string> {
        return new Promise((resolve, reject) => {
            exec(command, { cwd }, (error, stdout, stderr) => {
                if (error) {
                    // stderr is often more informative on error
                    reject(new Error(stderr || error.message));
                } else if (stderr) {
                    // Some tools write to stderr for non-error output
                    resolve(stderr);
                } else {
                    resolve(stdout);
                }
            });
        });
    }
}