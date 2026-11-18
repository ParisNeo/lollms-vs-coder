import * as vscode from 'vscode';
import * as path from 'path';
import { ToolDefinition, ToolExecutionEnv } from '../tool';

const BINARY_EXTENSIONS = new Set([
    '.exe', '.dll', '.so', '.dylib', '.bin', '.pkl', '.onnx', '.pt', '.pth', '.pyc',
    '.zip', '.tar', '.gz', '.7z', '.rar', '.iso', '.img', '.db', '.sqlite', '.sqlite3',
    '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.avi', '.mov', '.wav'
]);

const DOC_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.xls', '.pptx', '.msg', '.odt', '.rtf', '.ipynb']);

export const readExternalFileTool: ToolDefinition = {
    name: "read_external_file",
    description: "Reads a user-linked or imported external reference file outside the workspace sandbox (read-only). Call without 'path' to list all linked external files.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'filesystem_read',
    parameters: [
        {
            name: "path",
            type: "string",
            description: "Path or filename of the linked/external file to read. Omit to list all available linked external files.",
            required: false
        },
        {
            name: "start_line",
            type: "number",
            description: "Optional 1-based start line number to read a slice of the file.",
            required: false
        },
        {
            name: "end_line",
            type: "number",
            description: "Optional 1-based end line number to read a slice of the file.",
            required: false
        }
    ],
    manualTagFormat: `<read_external_file path="path/to/external_file.py" />`,
    async execute(
        params: { path?: string; file_path?: string; filePath?: string; file?: string; start_line?: number; end_line?: number },
        env: ToolExecutionEnv,
        signal: AbortSignal
    ): Promise<{ success: boolean; output: string }> {
        if (signal?.aborted) {
            return { success: false, output: "Read external file operation cancelled." };
        }

        const rawPath = (params?.path || params?.file_path || params?.filePath || params?.file || '').trim();
        const authorizedFiles = await env.contextManager.getAuthorizedExternalFiles();

        if (!rawPath) {
            if (authorizedFiles.length === 0) {
                return {
                    success: true,
                    output: "No external files are currently linked or imported in this workspace."
                };
            }
            const listText = authorizedFiles
                .map(f => `- \`${f.path}\` (${f.source === 'linked' ? 'Live Link' : f.source === 'external_files' ? 'Imported Doc' : 'Context'})`)
                .join('\n');
            return {
                success: true,
                output: `### 📚 AUTHORIZED EXTERNAL FILES (READ-ONLY)\n${listText}`
            };
        }

        const matched = await env.contextManager.resolveAuthorizedExternalFile(rawPath);
        if (!matched) {
            const availablePreview = authorizedFiles.length > 0
                ? `\n\n**Authorized external files available:**\n${authorizedFiles.map(f => `- \`${f.path}\``).join('\n')}`
                : '\n\nNo external files are currently linked or imported.';
            return {
                success: false,
                output: `🛑 Access Denied: '${rawPath}' is not in the user's linked or imported external files list.${availablePreview}`
            };
        }

        const lowerPath = matched.path.toLowerCase();
        const baseName = path.posix.basename(lowerPath);
        if (
            lowerPath.includes('/.ssh/') ||
            lowerPath.includes('/.aws/') ||
            lowerPath.includes('/.git/') ||
            baseName === '.env' ||
            baseName.startsWith('.env.') ||
            baseName.endsWith('.pem') ||
            baseName.endsWith('.key') ||
            baseName.startsWith('id_rsa') ||
            baseName.startsWith('id_ed25519')
        ) {
            return {
                success: false,
                output: `🛑 SECURITY VIOLATION: Reading credential or secret file '${matched.path}' is forbidden.`
            };
        }

        const ext = path.extname(matched.uri.fsPath).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) {
            return {
                success: false,
                output: `Error: External file '${matched.path}' is a binary artifact and cannot be read as text.`
            };
        }

        try {
            const fileBytes = await vscode.workspace.fs.readFile(matched.uri);
            let contentText = '';
            if (DOC_EXTENSIONS.has(ext)) {
                contentText = await env.contextManager.processFile(matched.fileName, Buffer.from(fileBytes).toString('base64'));
            } else {
                contentText = Buffer.from(fileBytes).toString('utf8');
            }

            const lines = contentText.split('\n');
            const totalLines = lines.length;
            const hasRange = typeof params?.start_line === 'number' || typeof params?.end_line === 'number';

            if (hasRange) {
                const startLine = Math.max(1, Math.floor(params?.start_line || 1));
                const endLine = Math.min(totalLines, Math.floor(params?.end_line || (startLine + 399)));
                if (startLine > totalLines) {
                    return {
                        success: false,
                        output: `Error: start_line (${startLine}) exceeds file line count (${totalLines}) for '${matched.path}'.`
                    };
                }
                const sliced = lines.slice(startLine - 1, endLine).join('\n');
                const lang = ext ? ext.substring(1) : 'text';
                return {
                    success: true,
                    output: `### 📄 EXTERNAL FILE (READ-ONLY): \`${matched.path}\` (lines ${startLine}-${endLine} of ${totalLines})\n\`\`\`${lang}\n${sliced}\n\`\`\``
                };
            }

            const MAX_CHARS = 60000;
            if (contentText.length > MAX_CHARS) {
                contentText = contentText.substring(0, MAX_CHARS) +
                    `\n\n... [Truncated at ${MAX_CHARS} chars; total ${contentText.length} chars / ${totalLines} lines. Use start_line and end_line to inspect further.]`;
            }

            const lang = ext ? ext.substring(1) : 'text';
            return {
                success: true,
                output: `### 📄 EXTERNAL FILE (READ-ONLY): \`${matched.path}\` (${totalLines} lines)\n\`\`\`${lang}\n${contentText}\n\`\`\``
            };
        } catch (err: any) {
            return {
                success: false,
                output: `Error reading external file '${matched.path}': ${err?.message || err}`
            };
        }
    }
};