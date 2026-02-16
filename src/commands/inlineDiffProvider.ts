import * as vscode from 'vscode';
import { ChatMessage, LollmsAPI } from '../lollmsAPI';
import { stripThinkingTags } from '../utils';

// Decorations for the inline diff visualization
const decorationTypeAdded = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(15, 157, 88, 0.15)', // Subtle Green
    isWholeLine: true,
    before: {
        contentText: '+',
        color: 'rgba(15, 157, 88, 0.8)',
        margin: '0 5px 0 5px',
        fontWeight: 'bold'
    }
});

const decorationTypeRemoved = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(244, 71, 71, 0.15)', // Subtle Red
    textDecoration: 'line-through',
    isWholeLine: true,
    before: {
        contentText: '-',
        color: 'rgba(244, 71, 71, 0.8)',
        margin: '0 5px 0 5px',
        fontWeight: 'bold'
    }
});

interface DiffLine {
    text: string;
    type: 'added' | 'removed' | 'unchanged';
}

interface DiffSession {
    id: string;
    editor: vscode.TextEditor;
    range: vscode.Range;
    originalText: string;
    currentText: string; // This stores the "Target" clean code (the intended result)
    diffLines: DiffLine[]; // This stores the "Display" interleaved lines
    history: ChatMessage[];
}

export class InlineDiffProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    private sessions: Map<string, DiffSession> = new Map();
    private lollmsAPI: LollmsAPI;

    constructor(lollmsAPI: LollmsAPI) {
        this.lollmsAPI = lollmsAPI;
    }

    /**
     * Starts an integrated diff session.
     * Compares original selection with AI output and creates a unified display.
     */
    public async startSession(
        editor: vscode.TextEditor, 
        range: vscode.Range, 
        newText: string, 
        history: ChatMessage[],
        lastAiResponse: string
    ) {
        const sessionId = Date.now().toString();
        const originalText = editor.document.getText(range);
        
        const originalLines = originalText.split(/\r?\n/);
        const newLines = newText.split(/\r?\n/);
        const diffLines: DiffLine[] = [];

        // --- INTEGRATED DIFF ALGORITHM ---
        // 1. Identify common prefix lines
        let prefixLines = 0;
        while (prefixLines < originalLines.length && prefixLines < newLines.length && 
               originalLines[prefixLines].trimEnd() === newLines[prefixLines].trimEnd()) {
            prefixLines++;
        }

        // 2. Identify common suffix lines
        let suffixLines = 0;
        while (suffixLines < (originalLines.length - prefixLines) && 
               suffixLines < (newLines.length - prefixLines) && 
               originalLines[originalLines.length - 1 - suffixLines].trimEnd() === newLines[newLines.length - 1 - suffixLines].trimEnd()) {
            suffixLines++;
        }

        // Build the Display List
        // Unchanged Prefix
        for (let i = 0; i < prefixLines; i++) {
            diffLines.push({ text: originalLines[i], type: 'unchanged' });
        }
        // Removed middle lines (Red)
        for (let i = prefixLines; i < originalLines.length - suffixLines; i++) {
            diffLines.push({ text: originalLines[i], type: 'removed' });
        }
        // Added middle lines (Green)
        for (let i = prefixLines; i < newLines.length - suffixLines; i++) {
            diffLines.push({ text: newLines[i], type: 'added' });
        }
        // Unchanged Suffix
        for (let i = originalLines.length - suffixLines; i < originalLines.length; i++) {
            diffLines.push({ text: originalLines[i], type: 'unchanged' });
        }

        const eol = editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
        const displayText = diffLines.map(l => l.text).join(eol);

        // Record history for the "Refine" feature
        history.push({ role: 'assistant', content: lastAiResponse });

        const session: DiffSession = {
            id: sessionId,
            editor,
            range,
            originalText,
            currentText: newText,
            diffLines,
            history
        };

        this.sessions.set(sessionId, session);

        // Apply the combined "Diff View" text to the editor
        await this.applyEdit(session, displayText);
        this._onDidChangeCodeLenses.fire();
    }

    private async applyEdit(session: DiffSession, text: string) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(session.editor.document.uri, session.range, text);
        await vscode.workspace.applyEdit(edit);

        // Update range to match the length of the multi-line diff block
        const lines = text.split(/\r?\n/);
        const startPos = session.range.start;
        const lastLineIndex = startPos.line + lines.length - 1;
        const lastLineLength = lines[lines.length - 1].length;
        
        session.range = new vscode.Range(startPos, new vscode.Position(lastLineIndex, lastLineLength));

        // Apply visual decorations
        const addedDecorations: vscode.Range[] = [];
        const removedDecorations: vscode.Range[] = [];

        let currentLineOffset = 0;
        session.diffLines.forEach(line => {
            const lineNum = startPos.line + currentLineOffset;
            const range = new vscode.Range(lineNum, 0, lineNum, line.text.length); 
            
            if (line.type === 'added') addedDecorations.push(range);
            else if (line.type === 'removed') removedDecorations.push(range);
            
            currentLineOffset++;
        });

        session.editor.setDecorations(decorationTypeAdded, addedDecorations);
        session.editor.setDecorations(decorationTypeRemoved, removedDecorations);
    }

    public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const lenses: vscode.CodeLens[] = [];

        for (const session of this.sessions.values()) {
            if (session.editor.document.uri.toString() === document.uri.toString()) {
                const range = new vscode.Range(session.range.start, session.range.start);

                lenses.push(new vscode.CodeLens(range, {
                    title: '$(check) Accept',
                    command: 'lollms-vs-coder.acceptDiff',
                    arguments: [session.id]
                }));

                lenses.push(new vscode.CodeLens(range, {
                    title: '$(comment-discussion) Refine...',
                    command: 'lollms-vs-coder.refineDiff',
                    arguments: [session.id]
                }));

                lenses.push(new vscode.CodeLens(range, {
                    title: '$(close) Reject',
                    command: 'lollms-vs-coder.rejectDiff',
                    arguments: [session.id]
                }));
            }
        }
        return lenses;
    }

    public async accept(sessionId: string) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        // Replace the diff block with just the clean AI-generated code
        const edit = new vscode.WorkspaceEdit();
        edit.replace(session.editor.document.uri, session.range, session.currentText);
        await vscode.workspace.applyEdit(edit);

        this.cleanupSession(session);
        vscode.window.showInformationMessage("Changes accepted.");
    }

    public async reject(sessionId: string) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        // Revert back to the text that existed before the AI intervention
        const edit = new vscode.WorkspaceEdit();
        edit.replace(session.editor.document.uri, session.range, session.originalText);
        await vscode.workspace.applyEdit(edit);

        this.cleanupSession(session);
        vscode.window.showInformationMessage("Changes rejected.");
    }

    private cleanupSession(session: DiffSession) {
        session.editor.setDecorations(decorationTypeAdded, []);
        session.editor.setDecorations(decorationTypeRemoved, []);
        this.sessions.delete(session.id);
        this._onDidChangeCodeLenses.fire();
    }

    public async refine(sessionId: string) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        const feedback = await vscode.window.showInputBox({
            prompt: "How should the code be adjusted?",
            placeHolder: "e.g., 'Make it more concise', 'Use a different naming convention'"
        });

        if (!feedback) return;

        session.history.push({ 
            role: 'user', 
            content: `Feedback on your previous output: ${feedback}\n\nPlease provide the updated code block only.` 
        });

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Lollms: Refining code...",
            cancellable: false
        }, async () => {
            try {
                const response = await this.lollmsAPI.sendChat(session.history);
                const cleanResponse = stripThinkingTags(response);
                
                const codeBlockMatch = cleanResponse.match(/```(?:\w+)?[\r\n]+([\s\S]*?)[\r\n]+```/);
                if (codeBlockMatch && codeBlockMatch[1]) {
                    const newCode = codeBlockMatch[1];
                    
                    // Cleanup visual diff of the previous iteration
                    session.editor.setDecorations(decorationTypeAdded, []);
                    session.editor.setDecorations(decorationTypeRemoved, []);
                    
                    // Restart with the new refined code
                    await this.startSession(
                        session.editor, 
                        session.range, 
                        newCode, 
                        session.history, 
                        cleanResponse
                    );
                }
            } catch (error: any) {
                vscode.window.showErrorMessage(`Refinement failed: ${error.message}`);
            }
        });
    }
}
