import * as vscode from 'vscode';
import { exec } from 'child_process';
import { ChatPanel } from './commands/chatPanel';

export class ScriptRunner {
  public runScript(code: string, language: string, panel: ChatPanel) {
    const tempDir = require('os').tmpdir();
    const fs = require('fs');
    const path = require('path');
    
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
      default:
        panel.addMessageToDiscussion({ role: 'system', content: `Unsupported language for execution: ${language}` });
        return;
    }

    const tempFile = path.join(tempDir, `lollms_script_${Date.now()}${fileExtension}`);
    fs.writeFileSync(tempFile, code);

    panel.addMessageToDiscussion({ role: 'system', content: `🚀 Executing ${language} script...` });
    
    const child = exec(`${command} "${tempFile}"`);
    let output = '';

    child.stdout?.on('data', (data) => { output += data.toString(); });
    child.stderr?.on('data', (data) => { output += data.toString(); });

    child.on('close', (code) => {
        const resultMessage = {
            role: 'system' as const,
            content: `**Execution Result (Exit Code: ${code})**\n\n\`\`\`\n${output || '(No output)'}\n\`\`\``
        };
        
        // Add the result message to the discussion, then trigger the AI analysis.
        // This ensures the result is in the history sent to the AI.
        panel.addMessageToDiscussion(resultMessage).then(() => {
            panel.analyzeExecutionResult(originalCode, language, output, code);
        });
        
        fs.unlinkSync(tempFile); // Clean up the temp file
    });
  }
}