import * as vscode from 'vscode';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

export const checkPythonSyntaxTool: ToolDefinition = {
    name: "check_python_syntax",
    description: "Verifies if a Python file is syntactically correct without executing it. Use this for 'Smoke Testing' after cleanup or refactoring to ensure no broken imports or indentation errors exist, especially in headless environments where running the full app would fail.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "file_path", type: "string", description: "Relative path to the .py file.", required: true }
    ],
    async execute(params: { file_path: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!env.workspaceRoot) return { success: false, output: "No workspace root." };

        const fs = require('fs/promises');
        const path = require('path');
        const scriptDir = path.join(env.workspaceRoot.uri.fsPath, ".lollms", "scripts");
        await fs.mkdir(scriptDir, { recursive: true });
        const scriptPath = path.join(scriptDir, `syntax_check_${Date.now()}.py`);

        const pythonCode = `
    import ast
    import sys
    import os

    def check():
    target = r'${params.file_path}'
    if not os.path.exists(target):
        print(f"FILE_NOT_FOUND: {target}")
        sys.exit(1)
    try:
        with open(target, 'r', encoding='utf-8') as f:
            ast.parse(f.read())
        print("SYNTAX_OK")
    except Exception as e:
        print(f"SYNTAX_ERROR: {e}")
        sys.exit(1)

    if __name__ == "__main__":
    check()
    `.trim();

        await fs.writeFile(scriptPath, pythonCode, 'utf8');
        const result = await env.agentManager!.runCommand(`python "${scriptPath}"`, signal);

        // Cleanup
        try { await fs.unlink(scriptPath); } catch(e) {}

        return result;
    }
};