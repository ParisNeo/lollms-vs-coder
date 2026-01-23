import * as vscode from 'vscode';
import { ChatPanel } from './commands/chatPanel/chatPanel';
import * as fs from 'fs';
import * as path from 'path';
import { runCommandInTerminal } from './extensionState';

export class ScriptRunner {
  private pythonExtApi: any;

  constructor(pythonExtApi: any) {
    this.pythonExtApi = pythonExtApi;
  }

  /**
   * Runs a script extracted from a chat code block.
   * Now uses the consolidated terminal logic for visibility and stoppable execution.
   */
  public async runScript(code: string, language: string, panel: ChatPanel, workspaceFolder: vscode.WorkspaceFolder) {
    if (!workspaceFolder) {
        panel.addMessageToDiscussion({ role: 'system', content: 'Cannot execute script: No workspace folder is open.' });
        return;
    }
    const workspaceRoot = workspaceFolder.uri.fsPath;
    const isWin = process.platform === 'win32';

    // Create a unique temporary file for this execution
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

    const langLower = language.toLowerCase();

    switch (langLower) {
      case 'py':
      case 'python': {
        fileExtension = '.py';
        tempFilePath = `${tempFileBase}${fileExtension}`;
        fs.writeFileSync(tempFilePath, code);
        
        let pythonExecutable = 'python'; // Default fallback

        // Try to respect the user's configured VS Code Python interpreter
        if (this.pythonExtApi) {
            try {
                const execDetails = this.pythonExtApi.settings.getExecutionDetails(workspaceFolder.uri);
                if (execDetails?.execCommand?.[0]) {
                    pythonExecutable = execDetails.execCommand[0];
                }
            } catch (error) {
                console.error("Error getting Python execution details:", error);
            }
        }
        
        // Use -u for unbuffered output to ensure real-time terminal updates
        fullCommand = `"${pythonExecutable}" -u "${tempFilePath}"`;
        break;
      }
      case 'javascript':
      case 'js':
        fileExtension = '.js';
        tempFilePath = `${tempFileBase}${fileExtension}`;
        fs.writeFileSync(tempFilePath, code);
        fullCommand = `node "${tempFilePath}"`;
        break;
      case 'typescript':
      case 'ts':
        fileExtension = '.ts';
        tempFilePath = `${tempFileBase}${fileExtension}`;
        fs.writeFileSync(tempFilePath, code);
        // Assumes ts-node or npx ts-node is available
        fullCommand = `npx ts-node "${tempFilePath}"`;
        break;
      case 'bash':
      case 'sh':
      case 'shell':
        fileExtension = isWin ? '.bat' : '.sh';
        tempFilePath = `${tempFileBase}${fileExtension}`;
        fs.writeFileSync(tempFilePath, code);
        
        if (isWin) {
            // Check if bash exists on Windows (Git Bash, WSL, etc.)
            fullCommand = `bash "${tempFilePath}"`;
            panel.addMessageToDiscussion({ 
                role: 'system', 
                content: `⚠️ **Windows Note:** Attempting to run a bash script. This requires Git Bash or WSL to be in your PATH. If this fails, ask the AI to generate a Batch (.bat) or PowerShell (.ps1) script instead.` 
            });
        } else {
            fullCommand = `bash "${tempFilePath}"`;
        }
        break;
      case 'powershell':
      case 'pwsh':
        fileExtension = '.ps1';
        tempFilePath = `${tempFileBase}${fileExtension}`;
        fs.writeFileSync(tempFilePath, code);
        fullCommand = `powershell -ExecutionPolicy Bypass -File "${tempFilePath}"`;
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
    
    panel.addMessageToDiscussion({ role: 'system', content: `🚀 Executing ${language} script in terminal... (You can stop it manually in the Terminal panel)` });
    
    try {
        // Execute in terminal using our centralized task-based logic
        const result = await runCommandInTerminal(
            fullCommand, 
            workspaceRoot, 
            `Lollms Script: ${langLower}`
        );
        
        const resultMessage = {
            role: 'system' as const,
            content: `**Execution Result (Success: ${result.success})**\n\n\`\`\`\n${result.output || '(No output)'}\n\`\`\``
        };
        panel.addMessageToDiscussion(resultMessage);
        
        // Analyze for potential fixes or explanation using the AI
        if (result.output.trim().length > 0) {
            panel.analyzeExecutionResult(originalCode, language, result.output, result.success ? 0 : 1);
        }

    } catch (err: any) {
        panel.addMessageToDiscussion({ role: 'system', content: `❌ Terminal execution error: ${err.message}` });
    } finally {
        // Cleanup the temporary script file
        try {
            if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
            }
        } catch (err: any) {
            console.error(`Failed to delete temporary script file: ${tempFilePath}`, err);
        }
    }
  }
}
