import * as vscode from 'vscode';
import * as path from 'path';
import { LollmsAPI } from '../lollmsAPI';
import { LollmsServices } from '../lollmsContext';
import { normalizeAiderContent, parseAiderHunks, applySearchReplace, stripThinkingTags } from '../utils';
import { Logger } from '../logger';
import { ChatPanel } from './chatPanel/chatPanel';

export interface TestResultItem {
    temperature: number | null; // null represents Automatic / No Temperature
    patchScore: number;
    promptScore: number;
    hallucinationScore: number;
    overallScore: number;
    details: {
        patch: { success: boolean; error?: string; output?: string };
        prompt: { score: number; rationale: string; output: string };
        hallucination: { score: number; rationale: string; output: string };
    };
}

export class ModelOptimizerPanel {
    public static currentPanel: ModelOptimizerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _lollmsAPI: LollmsAPI;
    private readonly _services: LollmsServices;
    private _disposables: vscode.Disposable[] = [];
    private _targetModel: string;
    private _isCancelled: boolean = false;
    private _activeAbortController: AbortController | null = null;
    private _humanResolvePromise: ((score: number) => void) | null = null;

    public static createOrShow(
        extensionUri: vscode.Uri,
        lollmsAPI: LollmsAPI,
        services: LollmsServices,
        initialModel?: string
    ) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : vscode.ViewColumn.One;

        if (ModelOptimizerPanel.currentPanel) {
            ModelOptimizerPanel.currentPanel._panel.reveal(column);
            if (initialModel) {
                ModelOptimizerPanel.currentPanel.setTargetModel(initialModel);
            }
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'lollmsModelOptimizer',
            '⚡ Test and Optimize Model Settings',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    extensionUri,
                    vscode.Uri.joinPath(extensionUri, 'out'),
                    vscode.Uri.joinPath(extensionUri, 'out', 'styles')
                ]
            }
        );

        ModelOptimizerPanel.currentPanel = new ModelOptimizerPanel(panel, extensionUri, lollmsAPI, services, initialModel);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        lollmsAPI: LollmsAPI,
        services: LollmsServices,
        initialModel?: string
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._lollmsAPI = lollmsAPI;
        this._services = services;
        this._targetModel = initialModel || lollmsAPI.getModelName();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._setWebviewMessageListener();
        this._panel.webview.html = this._getHtmlForWebview();

        this._initializeWebviewData();
    }

    public setTargetModel(model: string) {
        this._targetModel = model;
        this._panel.webview.postMessage({ command: 'setTargetModel', model });
    }

    public dispose() {
        this._isCancelled = true;
        if (this._activeAbortController) {
            this._activeAbortController.abort();
            this._activeAbortController = null;
        }
        if (this._humanResolvePromise) {
            this._humanResolvePromise(50);
            this._humanResolvePromise = null;
        }
        ModelOptimizerPanel.currentPanel = undefined;
        try {
            this._panel.dispose();
        } catch {}
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) x.dispose();
        }
    }

    private async _initializeWebviewData() {
        try {
            const models = await this._lollmsAPI.getModels(false);
            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            const judgeModel = config.get<string>('judgeModelName') || '';
            const boundSettings = config.get<Record<string, any>>('modelOptimalSettings') || {};

            this._panel.webview.postMessage({
                command: 'initData',
                models,
                targetModel: this._targetModel,
                judgeModel: judgeModel || this._targetModel,
                boundSettings
            });
        } catch (err: any) {
            Logger.warn("ModelOptimizerPanel init data failed", err);
        }
    }

    private _setWebviewMessageListener() {
        this._panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'webviewReady':
                    this._isWebviewReady = true;
                    await this._initializeWebviewData();
                    break;
                case 'startBenchmark':
                    await this.runBenchmark(message.options);
                    break;
                case 'cancelBenchmark':
                    this._isCancelled = true;
                    if (this._activeAbortController) {
                        this._activeAbortController.abort();
                    }
                    if (this._humanResolvePromise) {
                        this._humanResolvePromise(50);
                        this._humanResolvePromise = null;
                    }
                    break;
                case 'submitHumanScore':
                    if (this._humanResolvePromise) {
                        const score = Math.max(0, Math.min(100, parseInt(message.score, 10) || 50));
                        this._humanResolvePromise(score);
                        this._humanResolvePromise = null;
                    }
                    break;
                case 'saveOptimalSetting':
                    await this.saveOptimalSetting(message.model, message.setting);
                    break;
            }
        }, null, this._disposables);
    }

    private async runBenchmark(options: {
        targetModel: string;
        judgeMode: 'ai' | 'human';
        judgeModel: string;
        temperatures: (number | null)[];
    }) {
        this._isCancelled = false;
        this._activeAbortController = new AbortController();
        const signal = this._activeAbortController.signal;

        const targetModel = options.targetModel || this._targetModel;
        const judgeMode = options.judgeMode || 'ai';
        const judgeModel = options.judgeModel || targetModel;
        const temperatures = options.temperatures || [null, 0.0, 0.2, 0.5, 0.7];

        this._panel.webview.postMessage({
            command: 'benchmarkStarted',
            totalSteps: temperatures.length * 3
        });

        const results: TestResultItem[] = [];

        for (let tIdx = 0; tIdx < temperatures.length; tIdx++) {
            if (this._isCancelled || signal.aborted) break;

            const temp = temperatures[tIdx];
            const tempLabel = temp === null ? 'Automatic (No Temperature)' : `Temp ${temp}`;

            this._panel.webview.postMessage({
                command: 'stepProgress',
                status: `Testing ${tempLabel}...`,
                stepIndex: tIdx * 3,
                currentTemp: temp
            });

            // 1. Run Patching Benchmark (Automated by the system)
            const patchRes = await this.runPatchingTest(targetModel, temp, signal);

            // 2. Run Prompt Adherence Benchmark (AI Judge or Human)
            const promptRes = await this.runPromptAdherenceTest(targetModel, temp, judgeMode, judgeModel, signal);

            // 3. Run Anti-Hallucination Benchmark (Automated checks + AI Judge or Human)
            const halluRes = await this.runHallucinationTest(targetModel, temp, judgeMode, judgeModel, signal);

            const overallScore = Math.round(
                (patchRes.score * 0.40) +
                (promptRes.score * 0.35) +
                (halluRes.score * 0.25)
            );

            const resultItem: TestResultItem = {
                temperature: temp,
                patchScore: patchRes.score,
                promptScore: promptRes.score,
                hallucinationScore: halluRes.score,
                overallScore,
                details: {
                    patch: { success: patchRes.score === 100, error: patchRes.error, output: patchRes.output },
                    prompt: { score: promptRes.score, rationale: promptRes.rationale, output: promptRes.output },
                    hallucination: { score: halluRes.score, rationale: halluRes.rationale, output: halluRes.output }
                }
            };

            results.push(resultItem);

            this._panel.webview.postMessage({
                command: 'tempResultAdded',
                result: resultItem
            });
        }

        if (results.length > 0 && !this._isCancelled) {
            const best = [...results].sort((a, b) => b.overallScore - a.overallScore)[0];

            this._panel.webview.postMessage({
                command: 'benchmarkCompleted',
                results,
                bestSetting: best
            });
        } else {
            this._panel.webview.postMessage({ command: 'benchmarkCancelled' });
        }

        this._activeAbortController = null;
    }

    private async runPatchingTest(
        model: string,
        temp: number | null,
        signal: AbortSignal
    ): Promise<{ score: number; error?: string; output: string }> {
        const initialCode = `def calculate_cart_total(items, is_vip, tax_rate):
    """Calculates final cart price applying discounts and taxes."""
    subtotal = sum(item['price'] * item['qty'] for item in items)
    if subtotal <= 0:
        return 0.0

    discount = 0.0
    if is_vip:
        discount = subtotal * 0.05

    discounted_total = subtotal - discount
    final_price = discounted_total * (1.0 + tax_rate)
    return round(final_price, 2)
`;

        const userPrompt = `You are a surgical code editor. Modify the file \`cart_calculator.py\` below.
Increase the VIP discount from 0.05 (5%) to 0.15 (15%).
Output ONLY a standard Aider Search/Replace block:
<<<<<<< SEARCH
[exact lines to replace]
=======
[replacement lines]
>>>>>>> REPLACE

FILE CONTENT:
\`\`\`python
${initialCode}
\`\`\``;

        const options = temp !== null ? { temperature: temp } : undefined;

        try {
            const rawResponse = await this._lollmsAPI.sendChat(
                [{ role: 'user', content: userPrompt }],
                null,
                signal,
                model,
                options
            );

            const clean = stripThinkingTags(rawResponse).trim();
            const normalized = normalizeAiderContent(clean);
            const hunks = parseAiderHunks(normalized);

            if (hunks.length === 0) {
                return {
                    score: 0,
                    error: "No valid Aider search/replace markers found in model response.",
                    output: clean
                };
            }

            const hunk = hunks[0];
            const applyRes = applySearchReplace(initialCode, hunk.searchPart, hunk.replacePart);

            if (!applyRes.success) {
                return {
                    score: 25,
                    error: `Patch search block mismatch: ${applyRes.error}`,
                    output: clean
                };
            }

            const patched = applyRes.result;

            if (patched.includes('0.15') && !patched.includes('0.05') && !patched.includes('<<<<<<<') && !patched.includes('=======')) {
                return { score: 100, output: clean };
            } else if (patched.includes('0.15')) {
                return { score: 75, error: "Patch applied but leaked markers or retained stale code.", output: clean };
            } else {
                return { score: 40, error: "Patch applied cleanly but failed to update discount to 0.15.", output: clean };
            }
        } catch (err: any) {
            return { score: 0, error: err.message, output: "" };
        }
    }

    private async runPromptAdherenceTest(
        model: string,
        temp: number | null,
        judgeMode: 'ai' | 'human',
        judgeModel: string,
        signal: AbortSignal
    ): Promise<{ score: number; rationale: string; output: string }> {
        const userPrompt = `You are a database system architect.
Respond to the following scenario by strictly following ALL 4 constraints.

CONSTRAINTS:
1. Output exactly 3 bullet points, each starting with the literal prefix 'METRIC: '.
2. Each bullet point must state a specific database performance metric and its threshold.
3. You are STRICTLY FORBIDDEN from writing any introductory or concluding text (no 'Here are the metrics', no conversational greetings, no polite signoffs).
4. You are STRICTLY FORBIDDEN from wrapping the output in markdown code blocks or backticks.

Scenario: Tuning a high-volume PostgreSQL database handling 50,000 queries per second.`;

        const options = temp !== null ? { temperature: temp } : undefined;

        try {
            const rawResponse = await this._lollmsAPI.sendChat(
                [{ role: 'user', content: userPrompt }],
                null,
                signal,
                model,
                options
            );

            const clean = stripThinkingTags(rawResponse).trim();

            if (judgeMode === 'human') {
                const humanScore = await this.requestHumanEvaluation({
                    testName: "Prompt Adherence & Constraints",
                    temperature: temp,
                    prompt: userPrompt,
                    response: clean,
                    criteria: [
                        "Exactly 3 bullet points",
                        "Each starts with 'METRIC: '",
                        "Zero conversational preamble or sign-off",
                        "Zero markdown code blocks or backticks"
                    ]
                });
                return {
                    score: humanScore,
                    rationale: `Human evaluator awarded ${humanScore}/100.`,
                    output: clean
                };
            }

            const judgeSystem = `You are an impartial Judge Agent. Evaluate the candidate model's response against 4 strict negative and formatting constraints.
Return ONLY valid JSON:
{
  "score": number (0 to 100),
  "rationale": "1-2 sentence explanation of deductions",
  "bullet_count_ok": boolean (25 pts),
  "prefix_ok": boolean (25 pts),
  "no_preamble_or_chatter_ok": boolean (25 pts),
  "no_backticks_or_fences_ok": boolean (25 pts)
}`;

            const judgeUser = `CANDIDATE RESPONSE TO EVALUATE:
"""
${clean}
"""

Evaluate each constraint:
1. Exactly 3 bullet points? (25 pts)
2. Every item begins with 'METRIC: '? (25 pts)
3. Zero preamble or concluding commentary? (25 pts)
4. Zero code fences or backticks? (25 pts)`;

            const judgeRaw = await this._lollmsAPI.sendChat(
                [
                    { role: 'system', content: judgeSystem },
                    { role: 'user', content: judgeUser }
                ],
                null,
                signal,
                judgeModel,
                { thinking: false }
            );

            const cleanJudge = stripThinkingTags(judgeRaw);
            const jsonMatch = cleanJudge.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(100, parsed.score)) : 50;
                return {
                    score,
                    rationale: parsed.rationale || "AI Judge automated audit completed.",
                    output: clean
                };
            }

            const lines = clean.split('\n').filter(l => l.trim().length > 0);
            let fallbackScore = 0;
            if (lines.length === 3) fallbackScore += 25;
            if (lines.every(l => l.includes('METRIC:'))) fallbackScore += 25;
            if (!clean.toLowerCase().includes('here is') && !clean.toLowerCase().includes('here are')) fallbackScore += 25;
            if (!clean.includes('```')) fallbackScore += 25;

            return {
                score: fallbackScore,
                rationale: "Rule-based structural verification completed.",
                output: clean
            };
        } catch (err: any) {
            return { score: 0, rationale: `Test failed: ${err.message}`, output: "" };
        }
    }

    private async runHallucinationTest(
        model: string,
        temp: number | null,
        judgeMode: 'ai' | 'human',
        judgeModel: string,
        signal: AbortSignal
    ): Promise<{ score: number; rationale: string; output: string }> {
        const specContext = `### SPECIFICATION: NovaLock v1.0
NovaLock v1.0 is a strictly local in-memory mutex library with ONLY two functions:
- \`novalock_acquire(resource_id: str) -> bool\`: Locks a local mutex.
- \`novalock_release(resource_id: str) -> None\`: Releases a local mutex.

LIMITATIONS:
NovaLock v1.0 has NO network capabilities, NO distributed Redis/etcd clustering, NO timeouts, and NO automatic heartbeat renewal.`;

        const userPrompt = `${specContext}

TASK:
Based strictly on the specification above, explain how to configure NovaLock v1.0 for multi-server distributed clustering with a 30-second heartbeat timeout, and provide the exact function call. If NovaLock v1.0 does not support distributed clustering or heartbeats, state that explicitly and provide only the valid local mutex usage.`;

        const options = temp !== null ? { temperature: temp } : undefined;

        try {
            const rawResponse = await this._lollmsAPI.sendChat(
                [{ role: 'user', content: userPrompt }],
                null,
                signal,
                model,
                options
            );

            const clean = stripThinkingTags(rawResponse).trim();

            if (judgeMode === 'human') {
                const humanScore = await this.requestHumanEvaluation({
                    testName: "Anti-Hallucination & Grounding (NovaLock Trap)",
                    temperature: temp,
                    prompt: userPrompt,
                    response: clean,
                    criteria: [
                        "Explicitly recognized that NovaLock v1.0 has NO clustering/heartbeat support",
                        "Did NOT hallucinate fake functions (e.g. novalock_cluster, heartbeat, redis)",
                        "Used ONLY valid methods: novalock_acquire and novalock_release"
                    ]
                });
                return {
                    score: humanScore,
                    rationale: `Human evaluator awarded ${humanScore}/100.`,
                    output: clean
                };
            }

            const judgeSystem = `You are an expert Anti-Hallucination Judge.
Evaluate whether the candidate model resisted hallucinating fake features when prompted with a trap question about a fictional library (NovaLock v1.0).
Ground truth: NovaLock v1.0 ONLY supports novalock_acquire and novalock_release. It DOES NOT support clustering, network, or heartbeats.

Return ONLY valid JSON:
{
  "score": number (0 to 100),
  "hallucinated": boolean,
  "rationale": "1-2 sentence explanation"
}`;

            const judgeUser = `CANDIDATE RESPONSE:
"""
${clean}
"""

Did the model resist hallucination?
- 100 pts: Explicitly states distributed clustering/heartbeats are NOT supported, uses only novalock_acquire/release.
- 0-30 pts: Hallucinates fake clustering parameters, fake functions, or fake distributed configs.`;

            const judgeRaw = await this._lollmsAPI.sendChat(
                [
                    { role: 'system', content: judgeSystem },
                    { role: 'user', content: judgeUser }
                ],
                null,
                signal,
                judgeModel,
                { thinking: false }
            );

            const cleanJudge = stripThinkingTags(judgeRaw);
            const jsonMatch = cleanJudge.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(100, parsed.score)) : 50;
                return {
                    score,
                    rationale: parsed.rationale || "Grounded anti-hallucination audit completed.",
                    output: clean
                };
            }

            const lower = clean.toLowerCase();
            const hallucinated = lower.includes('novalock_cluster') || lower.includes('novalock_distributed') || lower.includes('heartbeat_interval');
            const acknowledged = lower.includes('does not support') || lower.includes('no support') || lower.includes('not supported') || lower.includes('cannot');

            const score = hallucinated ? 20 : (acknowledged ? 100 : 60);
            return {
                score,
                rationale: acknowledged ? "Correctly identified library limits." : "Did not explicitly address trap constraints.",
                output: clean
            };
        } catch (err: any) {
            return { score: 0, rationale: `Test failed: ${err.message}`, output: "" };
        }
    }

    private requestHumanEvaluation(details: {
        testName: string;
        temperature: number | null;
        prompt: string;
        response: string;
        criteria: string[];
    }): Promise<number> {
        return new Promise<number>((resolve) => {
            this._humanResolvePromise = resolve;
            this._panel.webview.postMessage({
                command: 'requestHumanReview',
                details
            });
        });
    }

    private async saveOptimalSetting(modelName: string, setting: { enableTemperature: boolean; temperature?: number; score?: number }) {
        if (!modelName) return;

        const config = vscode.workspace.getConfiguration('lollmsVsCoder');
        const current = config.get<Record<string, any>>('modelOptimalSettings') || {};

        const updated = {
            ...current,
            [modelName]: {
                enableTemperature: setting.enableTemperature,
                temperature: setting.enableTemperature ? setting.temperature : undefined,
                score: setting.score,
                updatedAt: new Date().toISOString()
            }
        };

        if (modelName.includes('::')) {
            const raw = modelName.split('::')[1];
            updated[raw] = updated[modelName];
        }

        await config.update('modelOptimalSettings', updated, vscode.ConfigurationTarget.Global);

        ChatPanel.panels.forEach((panel) => {
            const currentDisc = panel.getCurrentDiscussion();
            const discModel = currentDisc?.model || this._lollmsAPI.getModelName();
            if (discModel === modelName || (modelName.includes('::') && discModel === modelName.split('::')[1])) {
                panel.updateCapabilities({
                    enableTemperature: setting.enableTemperature,
                    temperature: setting.temperature
                });
            }
        });

        const tempLabel = setting.enableTemperature ? `Temperature ${setting.temperature}` : 'Automatic (No Temperature)';
        vscode.window.showInformationMessage(`✅ Optimal setting bound for ${modelName}: ${tempLabel} (Score: ${setting.score ?? 'N/A'}/100)`);

        this._panel.webview.postMessage({
            command: 'settingSaved',
            model: modelName,
            setting
        });
    }

    private _getHtmlForWebview(): string {
        const codiconsUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'styles', 'codicon.css'));
        const cspSource = this._panel.webview.cspSource;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; font-src ${cspSource}; script-src 'unsafe-inline';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Test & Optimize Model Settings</title>
    <link href="${codiconsUri}" rel="stylesheet" />
    <style>
        body {
            font-family: var(--vscode-font-family);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 24px;
            margin: 0;
            line-height: 1.5;
            overflow-y: auto;
        }
        .container {
            max-width: 960px;
            margin: 0 auto;
            display: flex;
            flex-direction: column;
            gap: 20px;
        }
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--vscode-widget-border);
        }
        .card {
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 8px;
            padding: 16px;
        }
        h2 { margin: 0 0 4px 0; font-size: 16px; color: var(--vscode-textLink-foreground); }
        h3 { margin: 0 0 10px 0; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.8; }
        .grid-2 {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
        }
        label {
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            display: block;
            margin-bottom: 6px;
            opacity: 0.85;
        }
        select, input[type="text"], input[type="number"] {
            width: 100%;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 6px 10px;
            border-radius: 4px;
            font-size: 12px;
            box-sizing: border-box;
            outline: none;
        }
        select:focus, input:focus {
            border-color: var(--vscode-focusBorder);
        }
        .checkbox-group {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            margin-top: 8px;
        }
        .checkbox-pill {
            display: flex;
            align-items: center;
            gap: 6px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-widget-border);
            padding: 4px 10px;
            border-radius: 16px;
            font-size: 11px;
            cursor: pointer;
            user-select: none;
            transition: all 0.15s;
        }
        .checkbox-pill.selected {
            border-color: var(--vscode-charts-blue);
            background: rgba(0, 122, 204, 0.15);
            font-weight: bold;
        }
        .checkbox-pill input { cursor: pointer; }
        button.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            font-weight: bold;
            font-size: 12px;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }
        button.primary:hover { filter: brightness(1.15); }
        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-widget-border);
            padding: 6px 12px;
            border-radius: 4px;
            font-size: 11px;
            cursor: pointer;
        }
        button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
        .results-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
            margin-top: 10px;
        }
        .results-table th {
            text-align: left;
            padding: 8px;
            background: var(--vscode-sideBarSectionHeader-background);
            border-bottom: 2px solid var(--vscode-widget-border);
            font-weight: 700;
        }
        .results-table td {
            padding: 8px;
            border-bottom: 1px solid var(--vscode-widget-border);
        }
        .results-table tr.optimal-row {
            background: rgba(56, 142, 60, 0.15);
            border-left: 4px solid var(--vscode-charts-green);
        }
        .score-badge {
            font-weight: 800;
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 11px;
            display: inline-block;
        }
        .score-high { background: rgba(56, 142, 60, 0.2); color: var(--vscode-charts-green); }
        .score-med { background: rgba(214, 122, 13, 0.2); color: var(--vscode-charts-orange); }
        .score-low { background: rgba(244, 71, 71, 0.2); color: var(--vscode-charts-red); }
        .spinner {
            width: 14px;
            height: 14px;
            border: 2px solid currentColor;
            border-bottom-color: transparent;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            display: inline-block;
        }
        @keyframes spin { 100% { transform: rotate(360deg); } }
        .human-modal {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.7);
            backdrop-filter: blur(4px);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
        }
        .human-modal-content {
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 8px;
            padding: 20px;
            max-width: 650px;
            width: 90%;
            max-height: 85vh;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h2>⚡ Test and Optimize Model Settings</h2>
                <div style="font-size:12px; opacity:0.75;">Benchmark code patching, prompt adherence, and anti-hallucination across temperatures to discover optimal bindings.</div>
            </div>
            <div id="bound-status-badge" style="font-size:11px; padding:3px 8px; border-radius:4px; background:var(--vscode-badge-background); display:none;"></div>
        </div>

        <div class="card">
            <h3>1. Target & Judge Configuration</h3>
            <div class="grid-2">
                <div>
                    <label for="targetModelSelect">Target Model to Test & Optimize</label>
                    <select id="targetModelSelect"></select>
                </div>
                <div>
                    <label for="judgeModeSelect">Instruction Following Evaluation Mode</label>
                    <select id="judgeModeSelect">
                        <option value="ai" selected>🤖 AI Judge Agent (Automated)</option>
                        <option value="human">👤 Human Evaluation (Manual Rating)</option>
                    </select>
                </div>
            </div>
            <div id="judgeModelRow" style="margin-top:12px;">
                <label for="judgeModelSelect">Judge Agent Model</label>
                <select id="judgeModelSelect"></select>
                <div style="font-size:10px; opacity:0.6; margin-top:2px;">Used to evaluate candidate adherence and hallucination resistance when AI Judge mode is active.</div>
            </div>
        </div>

        <div class="card">
            <h3>2. Temperature Ranges to Test</h3>
            <div style="font-size:11px; opacity:0.75; margin-bottom:8px;">Select which temperature levels to evaluate (including the model-native default without temperature parameter):</div>
            <div class="checkbox-group" id="tempCheckboxes">
                <label class="checkbox-pill selected"><input type="checkbox" value="null" checked> <span>Auto (No Temperature)</span></label>
                <label class="checkbox-pill selected"><input type="checkbox" value="0.0" checked> <span>0.0 (Deterministic)</span></label>
                <label class="checkbox-pill selected"><input type="checkbox" value="0.2" checked> <span>0.2 (Precise / Code)</span></label>
                <label class="checkbox-pill selected"><input type="checkbox" value="0.5" checked> <span>0.5 (Balanced)</span></label>
                <label class="checkbox-pill"><input type="checkbox" value="0.7"> <span>0.7 (Creative)</span></label>
                <label class="checkbox-pill"><input type="checkbox" value="1.0"> <span>1.0 (High Temp)</span></label>
            </div>
            <div style="display:flex; align-items:center; gap:8px; margin-top:12px;">
                <input type="number" id="customTempInput" placeholder="Add custom temp (e.g. 0.3)" step="0.1" min="0" max="2" style="width:180px;">
                <button type="button" id="btnAddCustomTemp" class="secondary">+ Add Temperature</button>
            </div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center;">
            <div id="progressStatus" style="font-size:12px; font-weight:bold; color:var(--vscode-charts-blue); display:none;">
                <span class="spinner"></span> <span id="progressText">Initializing benchmark suite...</span>
            </div>
            <div style="display:flex; gap:8px; margin-left:auto;">
                <button type="button" id="btnCancel" class="secondary" style="display:none; color:var(--vscode-errorForeground);">Cancel</button>
                <button type="button" id="btnRunBenchmark" class="primary"><i class="codicon codicon-play"></i> Run Benchmark & Optimize</button>
            </div>
        </div>

        <div class="card" id="resultsCard" style="display:none;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <h3>3. Optimization Matrix Results</h3>
                <div id="optimalBadge" style="display:none; background:var(--vscode-charts-green); color:white; font-size:10px; font-weight:bold; padding:2px 8px; border-radius:12px;"></div>
            </div>

            <table class="results-table">
                <thead>
                    <tr>
                        <th>Temperature Setting</th>
                        <th>Patching Accuracy (40%)</th>
                        <th>Prompt Following (35%)</th>
                        <th>Anti-Hallucination (25%)</th>
                        <th>Overall Score</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody id="resultsTableBody"></tbody>
            </table>

            <div id="recommendationArea" style="margin-top:16px; padding:12px; background:rgba(0,122,204,0.1); border-left:4px solid var(--vscode-charts-blue); border-radius:4px; display:none; justify-content:space-between; align-items:center;">
                <div>
                    <div style="font-weight:bold; font-size:12px;" id="recommendationTitle">Recommended Setting</div>
                    <div style="font-size:11px; opacity:0.8;" id="recommendationDetail"></div>
                </div>
                <button type="button" id="btnApplyOptimal" class="primary" style="background:var(--vscode-charts-green);"><i class="codicon codicon-check"></i> Apply & Save as Optimal</button>
            </div>
        </div>
    </div>

    <!-- Human Evaluation Review Modal -->
    <div class="human-modal" id="humanModal" style="display:none;">
        <div class="human-modal-content">
            <h3 style="color:var(--vscode-charts-orange); margin:0;" id="humanModalTitle">Human Evaluation Required</h3>
            <div style="font-size:11px; opacity:0.8;">The test runner requires your score on the candidate model's response:</div>
            
            <div>
                <label>Test Prompt Given to Model:</label>
                <pre style="background:var(--vscode-editor-background); padding:8px; border-radius:4px; font-size:10px; white-space:pre-wrap; max-height:120px; overflow-y:auto;" id="humanModalPrompt"></pre>
            </div>

            <div>
                <label>Candidate Model Response:</label>
                <pre style="background:var(--vscode-editor-background); padding:8px; border-radius:4px; font-size:11px; white-space:pre-wrap; max-height:200px; overflow-y:auto;" id="humanModalResponse"></pre>
            </div>

            <div id="humanCriteriaList" style="font-size:11px; background:rgba(255,255,255,0.04); padding:8px; border-radius:4px;"></div>

            <div style="display:flex; flex-direction:column; gap:6px;">
                <div style="display:flex; justify-content:space-between; font-size:11px; font-weight:bold;">
                    <span>Rating Score: <span id="humanScoreLabel" style="color:var(--vscode-charts-blue);">80</span> / 100</span>
                </div>
                <input type="range" id="humanScoreSlider" min="0" max="100" step="5" value="80">
            </div>

            <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:8px;">
                <button type="button" class="secondary" onclick="submitHumanScore(25)">Poor (25)</button>
                <button type="button" class="secondary" onclick="submitHumanScore(50)">Partial (50)</button>
                <button type="button" class="secondary" onclick="submitHumanScore(75)">Good (75)</button>
                <button type="button" class="secondary" onclick="submitHumanScore(100)">Perfect (100)</button>
                <button type="button" class="primary" id="btnConfirmHumanScore"><i class="codicon codicon-check"></i> Submit Score</button>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let loadedModels = [];
        let boundSettings = {};
        let activeResults = [];
        let bestSetting = null;

        const targetModelSelect = document.getElementById('targetModelSelect');
        const judgeModeSelect = document.getElementById('judgeModeSelect');
        const judgeModelSelect = document.getElementById('judgeModelSelect');
        const judgeModelRow = document.getElementById('judgeModelRow');
        const tempCheckboxes = document.getElementById('tempCheckboxes');
        const btnRunBenchmark = document.getElementById('btnRunBenchmark');
        const btnCancel = document.getElementById('btnCancel');
        const progressStatus = document.getElementById('progressStatus');
        const progressText = document.getElementById('progressText');
        const resultsCard = document.getElementById('resultsCard');
        const resultsTableBody = document.getElementById('resultsTableBody');
        const boundStatusBadge = document.getElementById('bound-status-badge');
        const recommendationArea = document.getElementById('recommendationArea');
        const recommendationTitle = document.getElementById('recommendationTitle');
        const recommendationDetail = document.getElementById('recommendationDetail');
        const btnApplyOptimal = document.getElementById('btnApplyOptimal');
        const optimalBadge = document.getElementById('optimalBadge');

        const humanModal = document.getElementById('humanModal');
        const humanModalTitle = document.getElementById('humanModalTitle');
        const humanModalPrompt = document.getElementById('humanModalPrompt');
        const humanModalResponse = document.getElementById('humanModalResponse');
        const humanCriteriaList = document.getElementById('humanCriteriaList');
        const humanScoreSlider = document.getElementById('humanScoreSlider');
        const humanScoreLabel = document.getElementById('humanScoreLabel');
        const btnConfirmHumanScore = document.getElementById('btnConfirmHumanScore');

        judgeModeSelect.onchange = () => {
            judgeModelRow.style.display = judgeModeSelect.value === 'ai' ? 'block' : 'none';
        };

        targetModelSelect.onchange = () => {
            updateBoundBadge();
        };

        humanScoreSlider.oninput = () => {
            humanScoreLabel.textContent = humanScoreSlider.value;
        };

        btnConfirmHumanScore.onclick = () => {
            submitHumanScore(parseInt(humanScoreSlider.value, 10));
        };

        function submitHumanScore(score) {
            humanModal.style.display = 'none';
            vscode.postMessage({ command: 'submitHumanScore', score });
        }

        tempCheckboxes.addEventListener('change', (e) => {
            if (e.target.tagName === 'INPUT') {
                e.target.closest('.checkbox-pill').classList.toggle('selected', e.target.checked);
            }
        });

        document.getElementById('btnAddCustomTemp').onclick = () => {
            const input = document.getElementById('customTempInput');
            const val = parseFloat(input.value);
            if (!isNaN(val) && val >= 0 && val <= 2) {
                const label = document.createElement('label');
                label.className = 'checkbox-pill selected';
                label.innerHTML = '<input type="checkbox" value="' + val + '" checked> <span>Temp ' + val + '</span>';
                tempCheckboxes.appendChild(label);
                input.value = '';
            }
        };

        btnRunBenchmark.onclick = () => {
            const checkedPills = tempCheckboxes.querySelectorAll('input:checked');
            const temps = Array.from(checkedPills).map(cb => cb.value === 'null' ? null : parseFloat(cb.value));

            if (temps.length === 0) {
                alert("Please select at least one temperature setting to test.");
                return;
            }

            activeResults = [];
            bestSetting = null;
            resultsTableBody.innerHTML = '';
            resultsCard.style.display = 'block';
            recommendationArea.style.display = 'none';
            optimalBadge.style.display = 'none';

            btnRunBenchmark.disabled = true;
            btnCancel.style.display = 'inline-flex';
            progressStatus.style.display = 'inline-flex';

            vscode.postMessage({
                command: 'startBenchmark',
                options: {
                    targetModel: targetModelSelect.value,
                    judgeMode: judgeModeSelect.value,
                    judgeModel: judgeModelSelect.value,
                    temperatures: temps
                }
            });
        };

        btnCancel.onclick = () => {
            vscode.postMessage({ command: 'cancelBenchmark' });
            btnCancel.style.display = 'none';
            progressText.textContent = 'Cancelling...';
        };

        btnApplyOptimal.onclick = () => {
            if (!bestSetting) return;
            vscode.postMessage({
                command: 'saveOptimalSetting',
                model: targetModelSelect.value,
                setting: {
                    enableTemperature: bestSetting.temperature !== null,
                    temperature: bestSetting.temperature !== null ? bestSetting.temperature : undefined,
                    score: bestSetting.overallScore
                }
            });
        };

        function getScoreBadge(score) {
            const cls = score >= 80 ? 'score-high' : (score >= 50 ? 'score-med' : 'score-low');
            return '<span class="score-badge ' + cls + '">' + score + '%</span>';
        }

        function renderResultsTable() {
            resultsTableBody.innerHTML = '';
            const sorted = [...activeResults];

            sorted.forEach(r => {
                const isBest = bestSetting && bestSetting.temperature === r.temperature;
                const tr = document.createElement('tr');
                if (isBest) tr.className = 'optimal-row';

                const tempLabel = r.temperature === null ? 'Automatic (No Temperature)' : 'Temperature ' + r.temperature;
                const bestTag = isBest ? ' <span style="color:var(--vscode-charts-green); font-weight:bold;">🏆 Optimal</span>' : '';

                tr.innerHTML = \`
                    <td><strong>\${tempLabel}</strong>\${bestTag}</td>
                    <td>\${getScoreBadge(r.patchScore)}</td>
                    <td>\${getScoreBadge(r.promptScore)}</td>
                    <td>\${getScoreBadge(r.hallucinationScore)}</td>
                    <td>\${getScoreBadge(r.overallScore)}</td>
                    <td>
                        <button type="button" class="secondary" style="font-size:10px; padding:2px 8px;" onclick="applySingleResult(\${r.temperature}, \${r.overallScore})">
                            Apply
                        </button>
                    </td>
                \`;
                resultsTableBody.appendChild(tr);
            });
        }

        window.applySingleResult = function(temp, score) {
            vscode.postMessage({
                command: 'saveOptimalSetting',
                model: targetModelSelect.value,
                setting: {
                    enableTemperature: temp !== null,
                    temperature: temp !== null ? temp : undefined,
                    score: score
                }
            });
        };

        function updateBoundBadge() {
            const currentModel = targetModelSelect.value;
            const rawModel = currentModel.includes('::') ? currentModel.split('::')[1] : currentModel;
            const bound = boundSettings[currentModel] || boundSettings[rawModel];

            if (bound) {
                boundStatusBadge.style.display = 'inline-block';
                const tempText = bound.enableTemperature ? 'Temp ' + bound.temperature : 'Auto (No Temp)';
                boundStatusBadge.innerHTML = 'Bound: <strong>' + tempText + '</strong>' + (bound.score ? ' (Score: ' + bound.score + ')' : '');
                boundStatusBadge.style.color = 'var(--vscode-charts-green)';
            } else {
                boundStatusBadge.style.display = 'inline-block';
                boundStatusBadge.textContent = 'Unbound (Uses Global Setting)';
                boundStatusBadge.style.color = 'var(--vscode-descriptionForeground)';
            }
        }

        // Send handshake immediately and on DOMContentLoaded
        vscode.postMessage({ command: 'webviewReady' });
        window.addEventListener('DOMContentLoaded', () => {
            vscode.postMessage({ command: 'webviewReady' });
        });

        window.addEventListener('message', (event) => {
            const msg = event.data;
            switch (msg.command) {
                case 'initData':
                    loadedModels = msg.models || [];
                    boundSettings = msg.boundSettings || {};

                    targetModelSelect.innerHTML = '';
                    judgeModelSelect.innerHTML = '';

                    loadedModels.forEach(m => {
                        const opt = new Option(m.name || m.id, m.id);
                        targetModelSelect.appendChild(opt);

                        const optJudge = new Option(m.name || m.id, m.id);
                        judgeModelSelect.appendChild(optJudge);
                    });

                    if (msg.targetModel) targetModelSelect.value = msg.targetModel;
                    if (msg.judgeModel) judgeModelSelect.value = msg.judgeModel;

                    updateBoundBadge();
                    break;

                case 'setTargetModel':
                    targetModelSelect.value = msg.model;
                    updateBoundBadge();
                    break;

                case 'stepProgress':
                    progressText.textContent = msg.status;
                    break;

                case 'tempResultAdded':
                    activeResults.push(msg.result);
                    renderResultsTable();
                    break;

                case 'requestHumanReview':
                    humanModalPrompt.textContent = msg.details.prompt;
                    humanModalResponse.textContent = msg.details.response;
                    humanModalTitle.textContent = "Human Review: " + msg.details.testName + " (" + (msg.details.temperature === null ? 'Auto Temp' : 'Temp ' + msg.details.temperature) + ")";
                    humanCriteriaList.innerHTML = "<strong>Evaluation Criteria:</strong><ul style='margin:4px 0 0 16px; padding:0;'>" + 
                        msg.details.criteria.map(c => "<li>" + c + "</li>").join('') + "</ul>";
                    humanScoreSlider.value = 80;
                    humanScoreLabel.textContent = "80";
                    humanModal.style.display = 'flex';
                    break;

                case 'benchmarkCompleted':
                    btnRunBenchmark.disabled = false;
                    btnCancel.style.display = 'none';
                    progressStatus.style.display = 'none';

                    bestSetting = msg.bestSetting;
                    renderResultsTable();

                    if (bestSetting) {
                        recommendationArea.style.display = 'flex';
                        optimalBadge.style.display = 'inline-block';
                        const bestName = bestSetting.temperature === null ? 'Automatic (Model Default - No Temperature)' : 'Temperature ' + bestSetting.temperature;
                        optimalBadge.textContent = '🏆 Optimal: ' + bestName + ' (' + bestSetting.overallScore + '%)';
                        recommendationTitle.textContent = 'Recommended: ' + bestName;
                        recommendationDetail.textContent = 'Yielded the highest combined accuracy across patching (40%), constraint adherence (35%), and anti-hallucination (25%). Score: ' + bestSetting.overallScore + '/100.';
                    }
                    break;

                case 'benchmarkCancelled':
                    btnRunBenchmark.disabled = false;
                    btnCancel.style.display = 'none';
                    progressStatus.style.display = 'none';
                    break;

                case 'settingSaved':
                    boundSettings[msg.model] = msg.setting;
                    updateBoundBadge();
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}

export default ModelOptimizerPanel;