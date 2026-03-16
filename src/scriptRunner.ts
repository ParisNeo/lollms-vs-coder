import * as vscode from 'vscode';
import { ChatPanel } from './commands/chatPanel/chatPanel';
import * as fs from 'fs';
import * as path from 'path';
import { runCommandInTerminal } from './extensionState';
import { getAvailableShells } from './utils';

export class ScriptRunner {
  private pythonExtApi: any;

  constructor(pythonExtApi: any) {
    this.pythonExtApi = pythonExtApi;
  }

  /**
   * Asks the LLM to translate a script to a compatible shell.
   */
  private async translateScript(code: string, fromLang: string, toLang: string, panel: ChatPanel): Promise<string | null> {
    const systemPrompt = `You are a script translation expert. 
Translate the provided ${fromLang} script into a ${toLang} script for the user's environment (${process.platform}).
- Ensure all logic (loops, conditionals, variables) is correctly converted.
- Provide ONLY the code block. 
- No conversational text.`;

    const userPrompt = `Translate this ${fromLang} to ${toLang}:\n\n\`\`\`${fromLang}\n${code}\n\`\`\``;

    return await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Lollms: Translating script to ${toLang}...`,
        cancellable: false
    }, async () => {
        try {
            const response = await panel._lollmsAPI.sendChat([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ]);
            // Extract code from response
            const match = response.match(/```(?:\w+)?\n([\s\S]+?)\n```/);
            return match ? match[1].trim() : response.trim();
        } catch (e) {
            return null;
        }
    });
  }

  public async runScript(code: string, language: string, panel: ChatPanel, workspaceFolder: vscode.WorkspaceFolder) {
    if (!workspaceFolder) {
        panel.addMessageToDiscussion({ role: 'system', content: 'Cannot execute script: No workspace folder is open.' });
        return;
    }
    const workspaceRoot = workspaceFolder.uri.fsPath;
    const isWin = process.platform === 'win32';
    const availableShells = await getAvailableShells();

    let currentCode = code;
    let currentLang = language.toLowerCase();

    // --- AGENTIC TRANSLATION LOGIC ---
    if (isWin && (currentLang === 'bash' || currentLang === 'sh' || currentLang === 'shell')) {
        if (!availableShells.includes('bash')) {
            const choice = await vscode.window.showWarningMessage(
                "Bash is not available on this Windows machine. Would you like the AI to translate this script to PowerShell?",
                "Translate & Run", "Cancel"
            );
            if (choice === "Translate & Run") {
                const translated = await this.translateScript(currentCode, currentLang, 'powershell', panel);
                if (translated) {
                    currentCode = translated;
                    currentLang = 'powershell';
                    panel.addMessageToDiscussion({ role: 'system', content: `🔄 **Script Translated:** Original ${language} converted to PowerShell for compatibility.` });
                } else {
                    panel.addMessageToDiscussion({ role: 'system', content: "❌ Translation failed." });
                    return;
                }
            } else {
                return;
            }
        }
    }

    const tempDir = path.join(workspaceRoot, '.lollms', 'temp_scripts');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    
    let fullCommand: string;
    let fileExtension: string;
    let targetShell: 'powershell' | 'cmd' | 'bash' | 'zsh' | 'fish' = isWin ? 'powershell' : 'bash';
    const originalCode = currentCode; 

    const tempFileBase = path.join(tempDir, `lollms_script_${Date.now()}`);
    let tempFilePath: string;

    switch (currentLang) {
      case 'py':
      case 'python': {
        fileExtension = '.py';
        tempFilePath = `${tempFileBase}${fileExtension}`;
        fs.writeFileSync(tempFilePath, currentCode);
        let pythonExecutable = 'python'; 
        if (this.pythonExtApi) {
            try {
                const execDetails = this.pythonExtApi.settings.getExecutionDetails(workspaceFolder.uri);
                if (execDetails?.execCommand?.[0]) pythonExecutable = execDetails.execCommand[0];
            } catch (error) {}
        }
        
        const relTempPath = path.relative(workspaceRoot, tempFilePath).replace(/\\/g, '/');
        
        if (isWin) {
            fullCommand = `& '${pythonExecutable}' -u '${relTempPath}'`;
            targetShell = 'powershell';
        } else {
            fullCommand = `"${pythonExecutable}" -u "${relTempPath}"`;
            targetShell = 'bash';
        }
        break;
      }
      case 'javascript':
      case 'js':
        fileExtension = '.js';
        tempFilePath = `${tempFileBase}${fileExtension}`;
        fs.writeFileSync(tempFilePath, currentCode);
        const relJsPath = path.relative(workspaceRoot, tempFilePath).replace(/\\/g, '/');
        fullCommand = `node '${relJsPath}'`;
        break;
      case 'typescript':
      case 'ts':
        fileExtension = '.ts';
        tempFilePath = `${tempFileBase}${fileExtension}`;
        fs.writeFileSync(tempFilePath, currentCode);
        const relTsPath = path.relative(workspaceRoot, tempFilePath).replace(/\\/g, '/');
        fullCommand = `npx ts-node '${relTsPath}'`;
        break;
      case 'bash':
      case 'sh':
      case 'shell':
      case 'zsh':
      case 'fish':
        fileExtension = '.sh';
        tempFilePath = `${tempFileBase}${fileExtension}`;
        fs.writeFileSync(tempFilePath, currentCode);
        const relShPath = path.relative(workspaceRoot, tempFilePath).replace(/\\/g, '/');
        
        const requestedShell = (currentLang === 'zsh' || currentLang === 'fish') ? currentLang : 'bash';
        const shellToUse = availableShells.includes(requestedShell) ? requestedShell : (isWin ? 'bash' : 'sh');
        
        if (isWin) {
            fullCommand = `${shellToUse} '${relShPath}'`;
            targetShell = 'bash';
        } else {
            fullCommand = `${shellToUse} "${relShPath}"`;
            targetShell = shellToUse as any;
        }
        break;
      case 'powershell':
      case 'pwsh':
        fileExtension = '.ps1';
        tempFilePath = `${tempFileBase}${fileExtension}`;
        fs.writeFileSync(tempFilePath, currentCode);
        const relPsPath = path.relative(workspaceRoot, tempFilePath).replace(/\\/g, '/');
        
        if (isWin) {
            fullCommand = `powershell -ExecutionPolicy Bypass -File '${relPsPath}'`;
            targetShell = 'powershell';
        } else {
            fullCommand = `pwsh -File "${relPsPath}"`;
            // @ts-ignore
            targetShell = 'pwsh';
        }
        break;
      case 'batch':
      case 'cmd':
      case 'bat':
        fileExtension = '.bat';
        tempFilePath = `${tempFileBase}${fileExtension}`;
        fs.writeFileSync(tempFilePath, currentCode);
        const relBatPath = path.relative(workspaceRoot, tempFilePath); // CMD prefers backslashes or forwards, relative is fine
        fullCommand = `"${relBatPath}"`;
        targetShell = 'cmd';
        break;
      default:
        panel.addMessageToDiscussion({ role: 'system', content: `Unsupported language for execution: ${language}` });
        return;
    }
    
    panel.addMessageToDiscussion({ role: 'system', content: `🚀 Executing ${currentLang} script in terminal...` });
    
    try {
        const result = await runCommandInTerminal(fullCommand, workspaceRoot, `Lollms Script: ${currentLang}`, undefined, { shell: targetShell });
        
        // Strip ANSI codes from the output before adding it to chat/context
        const { stripAnsiCodes } = require('./utils');
        const cleanOutput = stripAnsiCodes(result.output);

        const resultMessage = { role: 'system' as const, content: `**Execution Result (Success: ${result.success})**\n\n\`\`\`\n${cleanOutput || '(No output)'}\n\`\`\`` };
        panel.addMessageToDiscussion(resultMessage);
        
        if (cleanOutput.trim().length > 0) {
            panel.analyzeExecutionResult(originalCode, currentLang, cleanOutput, result.success ? 0 : 1);
        }
    } catch (err: any) {
        panel.addMessageToDiscussion({ role: 'system', content: `❌ Terminal execution error: ${err.message}` });
    } finally {
        try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (err: any) {}
    }
  }
}
