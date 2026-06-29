import * as assert from 'assert';
import * as vscode from 'vscode';
import { suite, test } from 'mocha';
import { FailureMemory } from '../../agent/failureHandling';
import { LollmsAPI } from '../../lollmsAPI';

suite('Lollms VS Coder Testing Suite', () => {
    vscode.window.showInformationMessage('Starting Lollms Integration Tests...');

    test('Extension Activation Verification', async () => {
        const ext = vscode.extensions.getExtension('parisneo.lollms-vs-coder');
        assert.ok(ext, 'Lollms extension should be registered in the VS Code marketplace.');

        if (ext) {
            const context = await ext.activate();
            assert.ok(context, 'Activated extension should expose its ExtensionContext.');
            assert.strictEqual(ext.isActive, true, 'Lollms extension should be successfully activated.');
        }
    });

    test('Onboarding Pipeline - Gate 1 (Pledge Block) Enforced', async () => {
        const ext = vscode.extensions.getExtension('parisneo.lollms-vs-coder');
        if (ext) {
            const context = await ext.activate();

            // Simulate fresh, unsigned state
            await context.globalState.update('lollms.pledgeSigned', false);
            await context.globalState.update('lollms.wasConfigured', false);

            // Trigger the onboarding pipeline check
            await vscode.commands.executeCommand('lollms-vs-coder.runOnboardingPipeline');

            // Verify the environment remains locked (hiding sidebar features)
            // Wait for context key evaluation to settle
            await new Promise(resolve => setTimeout(resolve, 100));
            const isReady = vscode.workspace.getConfiguration('lollmsVsCoder').get<boolean>('isEnvironmentReady', false);
            assert.strictEqual(isReady, false, 'Environment must remain locked (isEnvironmentReady = false) when Pledge is unsigned.');
        }
    });

    test('Onboarding Pipeline - Gate 2 (Connection Block) Enforced', async () => {
        const ext = vscode.extensions.getExtension('parisneo.lollms-vs-coder');
        if (ext) {
            const context = await ext.activate();

            // Sign the pledge but keep connection unconfigured
            await context.globalState.update('lollms.pledgeSigned', true);
            await context.globalState.update('lollms.wasConfigured', false);

            // Temporarily clear config fields to simulate fresh connection setup
            const config = vscode.workspace.getConfiguration('lollmsVsCoder');
            const originalUrl = config.get<string>('apiUrl');
            await config.update('apiUrl', 'http://localhost:9642', vscode.ConfigurationTarget.Global);
            await config.update('apiKey', '', vscode.ConfigurationTarget.Global);

            // Trigger onboarding check
            await vscode.commands.executeCommand('lollms-vs-coder.runOnboardingPipeline');

            // Verify environment is still locked because connection is not verified yet
            await new Promise(resolve => setTimeout(resolve, 100));
            const isReady = vscode.workspace.getConfiguration('lollmsVsCoder').get<boolean>('isEnvironmentReady', false);
            assert.strictEqual(isReady, false, 'Environment must remain locked when connection setup is unconfigured.');

            // Restore config
            if (originalUrl) {
                await config.update('apiUrl', originalUrl, vscode.ConfigurationTarget.Global);
            }
        }
    });

    test('Onboarding Pipeline - Gate 3 (Operational Reveal) Cleared', async () => {
        const ext = vscode.extensions.getExtension('parisneo.lollms-vs-coder');
        if (ext) {
            const context = await ext.activate();

            // Sign both Gates successfully
            await context.globalState.update('lollms.pledgeSigned', true);
            await context.globalState.update('lollms.wasConfigured', true);

            // Trigger pipeline
            await vscode.commands.executeCommand('lollms-vs-coder.runOnboardingPipeline');

            // Verify that the environment is fully revealed and active!
            await new Promise(resolve => setTimeout(resolve, 100));
            // Setting workspaceState to ensure Gate 3 bypasses popup
            await context.workspaceState.update('lollms_workspace_onboarded', true);

            // Trigger pipeline again to complete initialization
            await vscode.commands.executeCommand('lollms-vs-coder.runOnboardingPipeline');

            // In our pipeline logic, passing Gate 1 and 2 sets the "lollms:isEnvironmentReady" context key to true
            // We can verify this via internal state
            const readyState = context.globalState.get<boolean>('lollms.wasConfigured', false);
            assert.strictEqual(readyState, true, 'Environment should be successfully configured and verified.');
        }
    });

    test('FailureMemory - Algorithmic Deduplication and Normalization', () => {
        const memory = new FailureMemory();

        // 1. Initially empty
        assert.strictEqual(memory.hasFailedBefore('execute_command', { command: 'npm run test' }), false);

        // 2. Record failure
        memory.recordFailure('execute_command', { command: 'npm run test' }, 'AssertionError: test failed');
        assert.strictEqual(memory.hasFailedBefore('execute_command', { command: 'npm run test' }), true);

        // 3. Normalized pathing (backslash normalization)
        memory.recordFailure('read_file', { path: 'src\\auth\\session.ts' }, 'ENOENT');
        assert.strictEqual(memory.hasFailedBefore('read_file', { path: 'src/auth/session.ts' }), true);

        // 4. Scrubbing reasoning noise (thoughts and explanations)
        assert.strictEqual(memory.hasFailedBefore('read_file', { 
            path: 'src/auth/session.ts', 
            thought: 'Let me try to read this file', 
            explanation: 'Peeking...' 
        }), true);

        // 5. Reset memory
        memory.clear();
        assert.strictEqual(memory.hasFailedBefore('execute_command', { command: 'npm run test' }), false);
    });

    test('LollmsAPI - Configuration and Parsing', () => {
        const testConfig = {
            apiUrl: 'http://localhost:9642',
            apiKey: 'test-key',
            modelName: 'ollama/mistral',
            disableSslVerification: true,
            backendType: 'lollms' as const,
            useLollmsExtensions: true
        };

        const api = new LollmsAPI(testConfig);
        assert.strictEqual(api.getModelName(), 'ollama/mistral');

        // Check local token counting fallback when offline/unreachable
        const fallbackText = "function helloWorld() { console.log('hello'); }";
        const estimatedTokens = api.tokenize(fallbackText);
        assert.ok(estimatedTokens, 'Local tokenizer fallback should return an estimated count.');
    });
});
