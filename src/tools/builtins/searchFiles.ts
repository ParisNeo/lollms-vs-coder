import { ToolDefinition, ToolExecutionEnv } from '../tool';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';

const execAsync = promisify(exec);

export const searchFilesTool: ToolDefinition = {
    name: "search_files",
    description: "Searches for a text pattern in files within the workspace using git grep (if available) or system tools.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "pattern", type: "string", description: "The text pattern to search for.", required: true },
        { name: "path", type: "string", description: "The relative path to search in (default: root).", required: false }
    ],
    async execute(params: { pattern: string, path?: string }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.pattern) {
            return { success: false, output: "Error: 'pattern' is required." };
        }
        if (!env.workspaceRoot) {
            return { success: false, output: "Error: No active workspace folder." };
        }

        const searchPath = params.path || '.';
        const cwd = path.join(env.workspaceRoot.uri.fsPath, searchPath);
        const pattern = params.pattern.replace(/"/g, '\\"'); // Escape quotes

        try {
            // Try git grep first as it's fast and respects .gitignore
            try {
                const { stdout } = await execAsync(`git grep -n -I "${pattern}"`, { cwd });
                if (stdout.trim()) {
                    return { success: true, output: stdout.trim() };
                }
                return { success: true, output: "No matches found (git grep)." };
            } catch (e: any) {
                // git grep returns exit code 1 if not found, which throws an error in exec
                if (e.code === 1) {
                    return { success: true, output: "No matches found." };
                }
                // Fallback if not a git repo or other error
            }

            // Fallback to system tools
            let command = '';
            if (os.platform() === 'win32') {
                command = `findstr /S /N /I /P "${pattern}" *`;
            } else {
                command = `grep -r -n -I "${pattern}" .`;
            }

            const { stdout } = await execAsync(command, { cwd });
            return { success: true, output: stdout.trim() || "No matches found." };

        } catch (error: any) {
            if (error.code === 1) { // grep/findstr return 1 on no matches
                return { success: true, output: "No matches found." };
            }
            return { success: false, output: `Error searching files: ${error.message}` };
        }
    }
};
