import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface BillingEntry {
    timestamp: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    scope: string;
}

export interface ModelRate {
    pattern: string;
    inputRate: number;  // USD per 1M tokens
    outputRate: number; // USD per 1M tokens
}

export class TokenBillingManager {
    private static ledgerFile: vscode.Uri | undefined;
    private static cachedEntries: BillingEntry[] = [];

    public static initialize(context: vscode.ExtensionContext) {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            this.ledgerFile = vscode.Uri.joinPath(folders[0].uri, '.lollms', 'token_billing_ledger.json');
        }
        this.loadLedger();
    }

    private static async loadLedger() {
        if (!this.ledgerFile) return;
        try {
            const data = await vscode.workspace.fs.readFile(this.ledgerFile);
            this.cachedEntries = JSON.parse(Buffer.from(data).toString('utf8'));
        } catch {
            this.cachedEntries = [];
        }
    }

    private static async saveLedger() {
        if (!this.ledgerFile) return;
        try {
            const dir = vscode.Uri.joinPath(this.ledgerFile, '..');
            await vscode.workspace.fs.createDirectory(dir);
            const content = Buffer.from(JSON.stringify(this.cachedEntries, null, 2), 'utf8');
            await vscode.workspace.fs.writeFile(this.ledgerFile, content);
        } catch (e) {
            console.error("Failed to write token billing ledger:", e);
        }
    }

    public static calculateCost(model: string, input: number, output: number): { cost: number, rateMatched: boolean } {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const rates = config.get<ModelRate[]>('billing.rates') || [];

        const lowerModel = model.toLowerCase();
        // Strict model-level matching (e.g. matching 'gpt-4o-mini' directly instead of the generic binding)
        const matchedRate = rates.find(r => lowerModel.includes(r.pattern.toLowerCase()));

        if (matchedRate) {
            const inputCost = (input / 1000000) * matchedRate.inputRate;
            const outputCost = (output / 1000000) * matchedRate.outputRate;
            return { cost: inputCost + outputCost, rateMatched: true };
        }

        // Default fallback to standard gpt-4o rates if unmatched
        const inputCost = (input / 1000000) * 2.50;
        const outputCost = (output / 1000000) * 10.00;
        return { cost: inputCost + outputCost, rateMatched: false };
    }

    public static async logTransaction(model: string, input: number, output: number, scope: string) {
        const config = vscode.workspace.getConfiguration('lollmsVsCoder');

        // Return immediately if billing is deactivated globally
        if (config.get<boolean>('billing.enabled') === false) return;

        await this.loadLedger();

        const { cost } = this.calculateCost(model, input, output);
        const entry: BillingEntry = {
            timestamp: Date.now(),
            model,
            inputTokens: input,
            outputTokens: output,
            cost,
            scope
        };

        this.cachedEntries.push(entry);
        await this.saveLedger();

        // Budget Cap Warning Check
        const cappingEnabled = config.get<boolean>('billing.enableCapping') ?? false;
        const dailyCap = config.get<number>('billing.budgetCap') || 10.0;

        if (!cappingEnabled) return; // Exit if capping is disabled (unlimited)

        const todayStart = new Date().setHours(0,0,0,0);
        const dailyTotal = this.cachedEntries
            .filter(e => e.timestamp >= todayStart)
            .reduce((acc, e) => acc + e.cost, 0);

        if (dailyTotal > dailyCap) {
            vscode.window.showWarningMessage(
                `🚨 Daily Budget Exceeded! Today's spend of $${dailyTotal.toFixed(2)} exceeds your configured limit of $${dailyCap.toFixed(2)}.`,
                "Open Billing Dashboard", "Mute Warning"
            ).then(selection => {
                if (selection === "Open Billing Dashboard") {
                    vscode.commands.executeCommand('lollms-vs-coder.openBillingDashboard');
                }
            });
        }
    }

    public static getEntries(): BillingEntry[] {
        return this.cachedEntries;
    }

    public static async resetLedger() {
        this.cachedEntries = [];
        await this.saveLedger();
    }
}
