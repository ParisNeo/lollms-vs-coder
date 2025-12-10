import * as vscode from 'vscode';
import { ChatMessage, LollmsAPI } from '../lollmsAPI';
import { stripThinkingTags } from '../utils';

// Decoration for the temporary, AI-suggested code
const decorationTypeSuggestion = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(15, 157, 88, 0.15)', // A subtle green highlight
    isWholeLine: true,
});

interface DiffSession {
    id: string;
    editor: vscode.TextEditor;
    range: vscode.Range;
    originalText: string;
    currentText: string;
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

    public async startSession(
        editor: vscode.TextEditor, 
        range: vscode.Range, 
        newText: string, 
        history: ChatMessage[],
        lastAiResponse: string
    ) {
        const sessionId = Date.now().toString();
        const originalText = editor.document.getText(range);

        // Update history with the AI's response
        history.push({ role: 'assistant', content: lastAiResponse });

        const session: DiffSession = {
            id: sessionId,
            editor,
            range,
            originalText,
            currentText: newText,
            history
        };

        this.sessions.set(sessionId, session);

        // Apply the edit visibly
        await this.applyEdit(session, newText);
        this._onDidChangeCodeLenses.fire();
    }

    private async applyEdit(session: DiffSession, text: string) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(session.editor.document.uri, session.range, text);
        await vscode.workspace.applyEdit(edit);

        // Update range to match new text length
        const lines = text.split('\n');
        const newEndLine = session.range.start.line + lines.length - 1;
        const newEndChar = lines[lines.length - 1].length;
        session.range = new vscode.Range(session.range.start, new vscode.Position(newEndLine, newEndChar));
        session.currentText = text;

        // Apply decoration
        session.editor.setDecorations(decorationTypeSuggestion, [session.range]);
    }

    public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const lenses: vscode.CodeLens[] = [];

        for (const session of this.sessions.values()) {
            if (session.editor.document.uri.toString() === document.uri.toString()) {
                const range = new vscode.Range(session.range.start, session.range.start);

                // Accept Lens
                lenses.push(new vscode.CodeLens(range, {
                    title: '$(check) Accept',
                    command: 'lollms-vs-coder.acceptDiff',
                    arguments: [session.id]
                }));

                // Refine Lens
                lenses.push(new vscode.CodeLens(range, {
                    title: '$(comment-discussion) Refine...',
                    command: 'lollms-vs-coder.refineDiff',
                    arguments: [session.id]
                }));

                // Reject Lens
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

        session.editor.setDecorations(decorationTypeSuggestion, []);
        this.sessions.delete(sessionId);
        this._onDidChangeCodeLenses.fire();
        
        vscode.window.showInformationMessage("Changes accepted.");
    }

    public async reject(sessionId: string) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        // Revert text
        const edit = new vscode.WorkspaceEdit();
        edit.replace(session.editor.document.uri, session.range, session.originalText);
        await vscode.workspace.applyEdit(edit);

        session.editor.setDecorations(decorationTypeSuggestion, []);
        this.sessions.delete(sessionId);
        this._onDidChangeCodeLenses.fire();
        
        vscode.window.showInformationMessage("Changes rejected.");
    }

    public async refine(sessionId: string) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        const feedback = await vscode.window.showInputBox({
            prompt: "How should the code be adjusted?",
            placeHolder: "e.g., 'Use a different variable name', 'Fix the syntax error'"
        });

        if (!feedback) return;

        // Add user feedback to history
        session.history.push({ role: 'user', content: `Feedback: ${feedback}\n\nPlease update the code based on this feedback. Return ONLY the code block.` });

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Lollms: Refining code...",
            cancellable: false
        }, async () => {
            try {
                const response = await this.lollmsAPI.sendChat(session.history);
                const cleanResponse = stripThinkingTags(response);
                
                // Extract code
                const codeBlockMatch = cleanResponse.match(/```(?:[\w-]*)\n([\s\S]+?)\n```/);
                if (codeBlockMatch && codeBlockMatch[1]) {
                    const newCode = codeBlockMatch[1];
                    session.history.push({ role: 'assistant', content: cleanResponse });
                    await this.applyEdit(session, newCode);
                } else {
                    vscode.window.showErrorMessage("Lollms did not return a valid code block for the refinement.");
                }
            } catch (error: any) {
                vscode.window.showErrorMessage(`Refinement failed: ${error.message}`);
            }
        });
    }
}
