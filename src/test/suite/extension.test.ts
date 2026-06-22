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
            if (!ext.isActive) {
                await ext.activate();
            }
            assert.strictEqual(ext.isActive, true, 'Lollms extension should be successfully activated.');
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
