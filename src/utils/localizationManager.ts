import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Manages string localization for the extension using the @vscode/l10n standard.
 */
export class LocalizationManager {
    /**
     * Initializes the l10n sub-system.
     * VS Code automatically loads translation bundles from the 'l10n' folder 
     * defined in package.json based on the user's language setting.
     */
    public static async initialize(context: vscode.ExtensionContext): Promise<void> {
        await l10n.config({ extensionUri: context.extensionUri });
    }

    /**
     * Translates a key using the VS Code l10n system.
     * Logs a warning if the key is missing from the bundle.
     */
    public static t(key: string, ...args: any[]): string {
        const translation = l10n.t(key, ...args);
        
        // If the translation matches the key exactly, it wasn't found in any bundle
        if (translation === key) {
            console.warn(`[Lollms Localization] Missing translation key: "${key}"`);
        }
        
        return translation;
    }

    /**
     * Helper for Webview.
     * Loads the current language bundle from disk to pass to the webview.
     */
    public static getBundleForWebview(): Record<string, string> {
        const lang = vscode.env.language;
        const extensionPath = vscode.extensions.getExtension('parisneo.lollms-vs-coder')?.extensionPath;
        
        if (!extensionPath) {
            return {};
        }

        // Priority: 1. language specific bundle, 2. default bundle, 3. empty object
        const paths = [
            path.join(extensionPath, 'l10n', `bundle.l10n.${lang}.json`),
            path.join(extensionPath, 'l10n', `bundle.l10n.json`)
        ];

        for (const p of paths) {
            if (fs.existsSync(p)) {
                try {
                    return JSON.parse(fs.readFileSync(p, 'utf8'));
                } catch (e) {
                    console.error(`[Lollms Localization] Failed to parse bundle at ${p}`, e);
                }
            }
        }

        return {}; 
    }
}