import * as vscode from 'vscode';
import { exec } from 'child_process';
import { ChatPanel } from './commands/chatPanel';
import * as fs from 'fs';
import * as path from 'path';

export class ScriptRunner {
  private pythonExtApi: any;

  constructor(pythonExtApi: any) {
    this.pythonExtApi = pythonExtApi;
  }

  public async runScript(code: string, language: string, panel: ChatPanel, workspaceFolder: vscode.WorkspaceFolder) {
    if (!workspaceFolder) {
        panel.addMessageToDiscussion({ role: 'system', content: 'Cannot execute script: No workspace folder is open.' });
        return;
    }
    const workspaceRoot = workspaceFolder.uri.fsPath;

    const tempDir = path.join(workspaceRoot, '.lollms', 'temp_scripts');
    try {
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
    } catch (error: any) {
        panel.addMessageToDiscussion({ role: 'system', content: `Failed to create temporary script directory: ${error.message}` });
        return;
    }
    
    let fullCommand: string;
    let fileExtension: string;
    const originalCode = code; 

    const tempFileBase = path.join(tempDir, `lollms_script_${Date.now()}`);
    let tempFilePath: string;

    switch (language) {
      case 'py':
      case 'python': {
        fileExtension = '.py';
        tempFilePath = `${tempFileBase}${fileExtension}`;
        fs.writeFileSync(tempFilePath, code);
        
        let pythonExecutable = 'python'; // Default fallback

        if (this.pythonExtApi) {
            try {
                const execDetails = this.pythonExtApi.settings.getExecutionDetails(workspaceFolder.uri);
                if (execDetails?.execCommand?.[0]) {
                    pythonExecutable = execDetails.execCommand[0];
                    console.log(`Using configured Python interpreter from VS Code Python extension: ${pythonExecutable}`);
                } else {
                    console.warn("Could not get Python execution details from Python extension, falling back to 'python'.");
                }
            } catch (error) {
                console.error("Error getting Python execution details from extension API:", error);
                panel.addMessageToDiscussion({ role: 'system', content: `Error accessing Python interpreter details. Falling back to default 'python' command.` });
            }
        }
        
        fullCommand = `"${pythonExecutable}" -u "${tempFilePath}"`;
        break;
      }
      case 'javascript':
        fileExtension = '.js';
        tempFilePath = `${tempFileBase}${fileExtension}`;
        fs.writeFileSync(tempFilePath, code);
        fullCommand = `node "${tempFilePath}"`;
        break;
      case 'typescript':
        fileExtension = '.ts';
        tempFilePath = `${tempFileBase}${fileExtension}`;
        fs.writeFileSync(tempFilePath, code);
        fullCommand = `ts-node "${tempFilePath}"`;
        break;
      case 'bash':
      case 'sh':
      case 'shell':
        fileExtension = '.sh';
        tempFilePath = `${tempFileBase}${fileExtension}`;
        fs.writeFileSync(tempFilePath, code);
        fullCommand = `bash "${tempFilePath}"`;
        break;
      case 'powershell':
      case 'pwsh':
        fileExtension = '.ps1';
        tempFilePath = `${tempFileBase}${fileExtension}`;
        fs.writeFileSync(tempFilePath, code);
        fullCommand = `powershell -File "${tempFilePath}"`;
        break;
      case 'batch':
      case 'cmd':
      case 'bat':
        fileExtension = '.bat';
        tempFilePath = `${tempFileBase}${fileExtension}`;
        fs.writeFileSync(tempFilePath, code);
        fullCommand = `"${tempFilePath}"`;
        break;
      default:
        panel.addMessageToDiscussion({ role: 'system', content: `Unsupported language for execution: ${language}` });
        return;
    }
    
    panel.addMessageToDiscussion({ role: 'system', content: `🚀 Executing command: \`${fullCommand}\` in workspace...` });
    
    const child = exec(fullCommand, { cwd: workspaceRoot }, (error, stdout, stderr) => {
        const output = `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`;
        const exitCode = error ? (error as any).code : 0;
        
        // The 'ENOENT' error specifically means the command itself was not found
        if (error && (error as any).code === 'ENOENT') {
            const commandNotFoundMessage = {
                role: 'system' as const,
                content: `**Execution Failed (Error: ENOENT)**\n\nCould not find the command to execute the script. Please ensure the interpreter for '${language}' is installed and available in your system's PATH, or configured correctly in VS Code.\n\nCommand attempted:\n\`\`\`\n${fullCommand}\n\`\`\``
            };
            panel.addMessageToDiscussion(commandNotFoundMessage);
        } else {
            const resultMessage = {
                role: 'system' as const,
                content: `**Execution Result (Exit Code: ${exitCode})**\n\n\`\`\`\n${output || '(No output)'}\n\`\`\``
            };
            panel.addMessageToDiscussion(resultMessage);
            panel.analyzeExecutionResult(originalCode, language, output, exitCode);
        }

        try {
            fs.unlinkSync(tempFilePath); // Clean up the temp file
        } catch (err: any) {
            console.error(`Failed to delete temporary script file: ${tempFilePath}`, err);
        }
    });
  }
}