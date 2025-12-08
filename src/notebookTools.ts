import * as vscode from 'vscode';

export class LollmsNotebookCellActionProvider implements vscode.NotebookCellStatusBarItemProvider {

    provideCellStatusBarItems(cell: vscode.NotebookCell, token: vscode.CancellationToken): vscode.ProviderResult<vscode.NotebookCellStatusBarItem[]> {
        const items: vscode.NotebookCellStatusBarItem[] = [];

        // Action for prompt-based editing or generation
        const promptItem = new vscode.NotebookCellStatusBarItem(
            `$(edit) Edit/Gen`,
            vscode.NotebookCellStatusBarAlignment.Left
        );
        promptItem.command = {
            title: 'Generate or Edit with Lollms',
            command: 'lollms-vs-coder.promptToNotebookCell',
            arguments: [cell],
        };
        promptItem.tooltip = 'Generate code or edit this cell using a custom prompt';
        items.push(promptItem);

        // Action to enhance/refactor the current cell
        if (cell.document.getText().trim().length > 0) {
            const enhanceItem = new vscode.NotebookCellStatusBarItem(
                `$(sparkle) Enhance`,
                vscode.NotebookCellStatusBarAlignment.Left
            );
            enhanceItem.command = {
                title: 'Enhance Cell with Lollms',
                command: 'lollms-vs-coder.enhanceNotebookCell',
                arguments: [cell],
            };
            enhanceItem.tooltip = 'Refactor or enhance the content of this cell using AI';
            items.push(enhanceItem);
        }

        // Action to generate the next cell
        const generateNextItem = new vscode.NotebookCellStatusBarItem(
            `$(wand) Generate Next Cell`,
            vscode.NotebookCellStatusBarAlignment.Left
        );
        generateNextItem.command = {
            title: 'Generate Next Cell with Lollms',
            command: 'lollms-vs-coder.generateNextNotebookCell',
            arguments: [cell],
        };
        generateNextItem.tooltip = 'Use the content of this cell as context to generate the next code cell';
        items.push(generateNextItem);

        // NEW: Generate Educative Notebook
        const generateEducativeItem = new vscode.NotebookCellStatusBarItem(
            `$(book) Educative`,
            vscode.NotebookCellStatusBarAlignment.Left
        );
        generateEducativeItem.command = {
            title: 'Generate Educative Notebook',
            command: 'lollms-vs-coder.generateEducativeNotebook',
            arguments: [cell],
        };
        generateEducativeItem.tooltip = 'Generate a sequence of educative cells (text + code + plots) starting from this point';
        items.push(generateEducativeItem);

        // NEW: Explain Cell Action
        if (cell.document.getText().trim().length > 0 && cell.kind === vscode.NotebookCellKind.Code) {
             const explainItem = new vscode.NotebookCellStatusBarItem(
                `$(info) Explain`,
                vscode.NotebookCellStatusBarAlignment.Left
            );
            explainItem.command = {
                title: 'Explain Cell with Lollms',
                command: 'lollms-vs-coder.explainNotebookCell',
                arguments: [cell],
            };
            explainItem.tooltip = 'Generate a markdown explanation for this cell';
            items.push(explainItem);
        }

        // NEW: Visualize Data Action
        if (cell.kind === vscode.NotebookCellKind.Code && cell.outputs.length > 0) {
             const vizItem = new vscode.NotebookCellStatusBarItem(
                `$(graph) Visualize`,
                vscode.NotebookCellStatusBarAlignment.Left
            );
            vizItem.command = {
                title: 'Visualize Output with Lollms',
                command: 'lollms-vs-coder.visualizeNotebookCell',
                arguments: [cell],
            };
            vizItem.tooltip = 'Generate visualization code for this cell\'s output';
            items.push(vizItem);
        }

        // NEW: Analyze Output Action
        if (cell.outputs.length > 0) {
             const analyzeItem = new vscode.NotebookCellStatusBarItem(
                `$(beaker) Analyze Output`,
                vscode.NotebookCellStatusBarAlignment.Left
            );
            analyzeItem.command = {
                title: 'Analyze Output with Lollms',
                command: 'lollms-vs-coder.analyzeNotebookCellOutput',
                arguments: [cell],
            };
            analyzeItem.tooltip = 'Analyze the output of this cell using AI';
            items.push(analyzeItem);
        }

        // NEW: Fix Error Action (Visible only on failure)
        if (cell.executionSummary && cell.executionSummary.success === false) {
            const fixErrorItem = new vscode.NotebookCellStatusBarItem(
                `$(debug-restart) Fix with Lollms`,
                vscode.NotebookCellStatusBarAlignment.Right
            );
            fixErrorItem.command = {
                title: 'Fix Cell Error with Lollms',
                command: 'lollms-vs-coder.fixNotebookCellError',
                arguments: [cell],
            };
            fixErrorItem.tooltip = 'Analyze the error trace and auto-correct the cell code';
            fixErrorItem.priority = 200; // High priority to be visible on the right
            items.push(fixErrorItem);
        }

        return items;
    }
}
