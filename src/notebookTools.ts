import * as vscode from 'vscode';

export class LollmsNotebookCellActionProvider implements vscode.NotebookCellStatusBarItemProvider {

    provideCellStatusBarItems(cell: vscode.NotebookCell, token: vscode.CancellationToken): vscode.ProviderResult<vscode.NotebookCellStatusBarItem[]> {
        const items: vscode.NotebookCellStatusBarItem[] = [];

        // Action pour améliorer/refactoriser la cellule actuelle
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

        // Action pour générer la cellule suivante
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

        return items;
    }
}