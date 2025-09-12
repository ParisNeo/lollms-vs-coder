import * as vscode from 'vscode';

// Decoration for the temporary, AI-suggested code
const decorationTypeSuggestion = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(15, 157, 88, 0.15)', // A subtle green highlight
    isWholeLine: true,
});

export class InlineDiffProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    private _active: boolean = false;
    private _range: vscode.Range | null = null;
    private _newText: string = '';
    private _originalText: string = ''; // To store the original code
    private _editor: vscode.TextEditor | null = null;
    private isApplyingEdit: boolean = false; // Flag to prevent auto-rejection on our own edits

    constructor() {
        // If the user starts editing or changes documents, automatically reject the suggestion.
        vscode.window.onDidChangeActiveTextEditor(() => this.reject());
        vscode.workspace.onDidChangeTextDocument(async e => {
            if (this.isApplyingEdit) return; // Ignore our own programmatic changes

            if (this._active && e.document === this._editor?.document) {
                // User interfered with the document, so automatically reject the pending suggestion
                await this.reject();
            }
        });
    }

    public async showDiff(editor: vscode.TextEditor, range: vscode.Range, newText: string) {
        if (this._active) {
            await this.reject(); // Reject any previous active suggestion before showing a new one
        }

        this.isApplyingEdit = true;

        this._editor = editor;
        this._originalText = editor.document.getText(range);
        this._newText = newText;

        // Perform the temporary edit to show the AI's suggestion in the editor
        await editor.edit(editBuilder => {
            editBuilder.replace(range, newText);
        });

        // Calculate the new range of the inserted text
        const startPos = range.start;
        const endLine = startPos.line + (newText.split('\n').length - 1);
        const endChar = (newText.split('\n').pop() || '').length;
        const newRange = new vscode.Range(startPos, new vscode.Position(endLine, endChar));
        
        this._range = newRange;
        this._active = true;

        this.applyDecorations();
        this._onDidChangeCodeLenses.fire();

        this.isApplyingEdit = false;
    }
    
    private applyDecorations() {
        if (!this._editor || !this._range) return;
        // Apply the background highlight to the newly inserted code
        this._editor.setDecorations(decorationTypeSuggestion, [this._range]);
    }

    public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (!this._active || !this._range || document !== this._editor?.document) {
            return [];
        }

        const range = new vscode.Range(this._range.start, this._range.start);

        const acceptCommand: vscode.Command = {
            title: '✅ Accept',
            command: 'lollms-vs-coder.acceptDiff'
        };
        const rejectCommand: vscode.Command = {
            title: '❌ Reject',
            command: 'lollms-vs-coder.rejectDiff'
        };

        return [new vscode.CodeLens(range, acceptCommand), new vscode.CodeLens(range, rejectCommand)];
    }
    
    public async accept() {
        if (!this._active) return;
        // The text is already what we want, so we just clear the state and decorations.
        this.clearAndDeactivate();
    }
    
    public async reject() {
        if (!this._active || !this._editor || !this._range) {
            // If already inactive, just ensure everything is cleared.
            this.clearAndDeactivate();
            return;
        }

        this.isApplyingEdit = true;
        
        const editor = this._editor;
        const range = this._range;
        const originalText = this._originalText;

        // Revert the text back to the original content
        await editor.edit(editBuilder => {
            editBuilder.replace(range, originalText);
        });
        
        this.clearAndDeactivate();

        this.isApplyingEdit = false;
    }

    private clearDecorations() {
        if (this._editor) {
            this._editor.setDecorations(decorationTypeSuggestion, []);
        }
    }

    private clearAndDeactivate() {
        this.clearDecorations();
        this._active = false;
        this._range = null;
        this._editor = null;
        this._newText = '';
        this._originalText = '';
        this._onDidChangeCodeLenses.fire();
    }
}