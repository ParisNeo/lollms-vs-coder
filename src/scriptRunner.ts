import * as vscode from 'vscode';
import { exec } from 'child_process';
import { ChatPanel } from './commands/chatPanel';
import * as fs from 'fs';
import * as path from 'path';

export class ScriptRunner {
  public runScript(code: string, language: string, panel: ChatPanel) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        panel.addMessageToDiscussion({ role: 'system', content: 'Cannot execute script: No workspace folder is open.' });
        return;
    }
    const workspaceRoot = workspaceFolder.uri.fsPath;

    // Create a temporary directory inside the workspace's .lollms folder
    const tempDir = path.join(workspaceRoot, '.lollms', 'temp_scripts');
    try {
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
    } catch (error: any) {
        panel.addMessageToDiscussion({ role: 'system', content: `Failed to create temporary script directory: ${error.message}` });
        return;
    }
    
    let command: string;
    let fileExtension: string;
    const originalCode = code; 

    switch (language) {
      case 'python':
        fileExtension = '.py';
        command = `python -u`;
        break;
      case 'javascript':
        fileExtension = '.js';
        command = 'node';
        break;
      case 'typescript':
        fileExtension = '.ts';
        command = 'ts-node';
        break;
      case 'bash':
      case 'sh':
      case 'shell':
        fileExtension = '.sh';
        command = 'bash';
        break;
      case 'powershell':
      case 'pwsh':
        fileExtension = '.ps1';
        command = 'powershell -File';
        break;
      case 'batch':
      case 'cmd':
      case 'bat':
        fileExtension = '.bat';
        command = 'cmd.exe /c';
        break;
      default:
        panel.addMessageToDiscussion({ role: 'system', content: `Unsupported language for execution: ${language}` });
        return;
    }

    const tempFile = path.join(tempDir, `lollms_script_${Date.now()}${fileExtension}`);
    fs.writeFileSync(tempFile, code);

    panel.addMessageToDiscussion({ role: 'system', content: `🚀 Executing ${language} script from workspace...` });
    
    // Execute the command with the CWD set to the workspace root
    const child = exec(`${command} "${tempFile}"`, { cwd: workspaceRoot });
    let output = '';

    child.stdout?.on('data', (data) => { output += data.toString(); });
    child.stderr?.on('data', (data) => { output += data.toString(); });

    child.on('close', (code) => {
        const resultMessage = {
            role: 'system' as const,
            content: `**Execution Result (Exit Code: ${code})**\n\n\`\`\`\n${output || '(No output)'}\n\`\`\``
        };
        
        panel.addMessageToDiscussion(resultMessage).then(() => {
            panel.analyzeExecutionResult(originalCode, language, output, code);
        });
        
        try {
            fs.unlinkSync(tempFile); // Clean up the temp file
        } catch (error: any) {
            console.error(`Failed to delete temporary script file: ${tempFile}`, error);
            panel.addMessageToDiscussion({ role: 'system', content: `⚠️ Failed to delete temporary script file: ${path.basename(tempFile)}` });
        }
    });
  }
}