import * as vscode from 'vscode';
import * as path from 'path';

export async function applyDiff(diffContent: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        throw new Error('No workspace folder open.');
    }
    const workspaceRoot = workspaceFolders[0].uri;

    // Basic parsing to find the file path from '--- a/path/to/file' or '+++ b/path/to/file'
    const fileMatch = diffContent.match(/^(?:--- a\/|\+\+\+ b\/)(.*)$/m);
    if (!fileMatch) {
        throw new Error('Could not determine file path from diff.');
    }
    const relativePath = fileMatch[1].trim();
    const fileUri = vscode.Uri.joinPath(workspaceRoot, relativePath);

    let document;
    try {
        document = await vscode.workspace.openTextDocument(fileUri);
    } catch (error) {
        throw new Error(`File not found: ${relativePath}`);
    }

    const originalLines = document.getText().split('\n');
    const diffLines = diffContent.split('\n');
    const edit = new vscode.WorkspaceEdit();

    let originalLineIndex = -1; // -1 because hunk headers are 1-based

    for (const line of diffLines) {
        if (line.startsWith('@@')) {
            const hunkMatch = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (hunkMatch) {
                originalLineIndex = parseInt(hunkMatch[1], 10) - 1;
            }
        } else if (line.startsWith('-')) {
            if (originalLineIndex >= 0) {
                const range = new vscode.Range(new vscode.Position(originalLineIndex, 0), new vscode.Position(originalLineIndex + 1, 0));
                // Verify the line matches before deleting
                if (originalLines[originalLineIndex].trimEnd() === line.substring(1).trimEnd()) {
                    edit.delete(fileUri, range);
                    originalLineIndex++;
                } else {
                   // Ignore if doesn't match, could be context mismatch
                }
            }
        } else if (line.startsWith('+')) {
            if (originalLineIndex >= 0) {
                edit.insert(fileUri, new vscode.Position(originalLineIndex, 0), line.substring(1) + '\n');
            }
        } else if (line.startsWith(' ')) {
            if(originalLineIndex >= 0) {
                originalLineIndex++;
            }
        }
    }

    const success = await vscode.workspace.applyEdit(edit);
    if (!success) {
        throw new Error('VS Code failed to apply edits.');
    }
    // Save the document after applying changes
    await document.save();
}