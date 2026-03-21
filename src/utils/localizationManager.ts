import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Manages string localization for the extension using the @vscode/l10n standard.
 */
export class LocalizationManager {
    private static isInitialized = false;
    private static currentBundle: Record<string, string> = {};

    /**
     * Initializes the l10n sub-system.
     * @param context The extension context.
     */
    public static async initialize(context: vscode.ExtensionContext): Promise<void> {
        if (this.isInitialized) return;

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const configLanguage = config.get<string>('language') || 'auto';
        const locale = configLanguage === 'auto' ? vscode.env.language : configLanguage;

        // Try to find the l10n directory in 'out' or root
        const possibleDirs = [
            path.join(context.extensionUri.fsPath, 'out', 'l10n'),
            path.join(context.extensionUri.fsPath, 'l10n')
        ];

        let bundleDir = possibleDirs[0];
        for (const dir of possibleDirs) {
            if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
                bundleDir = dir;
                break;
            }
        }

        // 1. Initialize official l10n
        try {
            await l10n.config({ fsPath: bundleDir });
        } catch (e) {
            console.error(`[Lollms Debug] l10n.config failed: ${e}`);
        }

        // 2. Load manual bundle for Webview
        // We strip locale variations (e.g. en-us -> en) to find the right file
        const baseLocale = locale.split('-')[0].toLowerCase();
        const bundleFiles = [
            path.join(bundleDir, `bundle.l10n.${locale}.json`),      // e.g. bundle.l10n.zh-cn.json
            path.join(bundleDir, `bundle.l10n.${baseLocale}.json`),  // e.g. bundle.l10n.en.json
            path.join(bundleDir, 'bundle.l10n.json')                 // default fallback
        ];

        for (const bPath of bundleFiles) {
            try {
                if (fs.existsSync(bPath) && fs.statSync(bPath).isFile()) {
                    console.log(`[Lollms Debug] Loading bundle: ${path.basename(bPath)}`);
                    const content = fs.readFileSync(bPath, 'utf8');
                    this.currentBundle = JSON.parse(content);
                    break; // Stop at first valid file found
                }
            } catch (e) {
                console.error(`[Lollms Debug] Error reading ${bPath}:`, e);
            }
        }

        this.isInitialized = true;
    }

    /**
     * Translates a key using the VS Code l10n system.
     * Use this for server-side strings.
     */
    public static t(key: string, ...args: any[]): string {
        return l10n.t(key, ...args);
    }

    /**
     * Returns the entire translation bundle for the current locale.
     * This is used to pass all translations to the Webview at once.
     */
    public static getBundleForWebview(): Record<string, string> {
        return this.currentBundle;
    }
}