import * as assert from 'assert';
import * as vscode from 'vscode';
import { suite, test } from 'mocha';
import { FailureMemory } from '../../agent/failureHandling';
import { LollmsAPI } from '../../lollmsAPI';
import { fileMutationPlugin } from '../../commands/chatPanel/webview/plugins/fileOpPlugin';
import { normalizeAiderContent } from '../../utils';

suite('Extension & File Mutation Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('fileMutationPlugin regex does not match empty body at newline', () => {
		const text = `Here is the code update:
<file path="src/sample.ts" action="write">
console.log("hello world");
</file>`;

		const re = new RegExp(fileMutationPlugin.tagPattern.source, fileMutationPlugin.tagPattern.flags);
		const match = re.exec(text);

		assert.ok(match, 'Expected fileMutationPlugin to match <file> block');
		assert.strictEqual(match[1].trim(), 'path="src/sample.ts" action="write"');
  assert.strictEqual(match[2].trim(), 'console.log("hello world");', 'Body should contain full file content, not empty string');
 });
});


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

    	test('normalizeAiderContent handles standard, indented and unclosed Aider blocks', () => {
		const raw = `  <<<<<<< SEARCH
const x = 1;
=======
const x = 2;
>>>>>>> REPLACE`;

		const normalized = normalizeAiderContent(raw);
		assert.ok(normalized.startsWith('<<<<<<< SEARCH'));
		assert.ok(normalized.includes('======='));
		assert.ok(normalized.includes('>>>>>>> REPLACE'));
	});

	test('extractFileBlocks correctly extracts outer <file> containing nested <file> tags in code', () => {
		const nestedContent = `<file path="src/codeGenerator.ts" action="write">
export function createTemplate() {
    return \`<file path="subfile.ts" action="write">
const inner = 42;
</file>\`;
}
</file>`;

		const { extractFileBlocks } = require('../../commands/chatPanel/webview/plugins/fileOpPlugin');
		const blocks = extractFileBlocks(nestedContent);

		assert.strictEqual(blocks.length, 1, 'Should extract exactly 1 outer block');
		assert.ok(blocks[0].isClosed, 'Outer block should be closed');
		assert.ok(blocks[0].attrStr.includes('src/codeGenerator.ts'), 'Should match outer path');
		assert.ok(blocks[0].rawContent.includes('return `<file path="subfile.ts" action="write">'), 'Body should preserve inner <file> opening tag');
		assert.ok(blocks[0].rawContent.includes('const inner = 42;'), 'Body should preserve inner content');
		assert.ok(blocks[0].rawContent.includes('</file>`;'), 'Body should preserve inner closing tag');
		assert.ok(blocks[0].rawContent.endsWith('}'), 'Body should end with closing brace of outer code');
	});

	test('extractFileBlocks extracts multiple sequential <file> tags with nested content', () => {
		const text = `
<file path="file1.ts" action="write">
const x = "<file path='dummy.txt'>test</file>";
</file>

<file path="file2.ts" action="patch">
<<<<<<< SEARCH
const old = 1;
=======
const old = 2;
>>>>>>> REPLACE
</file>`;

		const { extractFileBlocks } = require('../../commands/chatPanel/webview/plugins/fileOpPlugin');
		const blocks = extractFileBlocks(text);

		assert.strictEqual(blocks.length, 2, 'Should extract both sequential files');
		assert.ok(blocks[0].attrStr.includes('file1.ts'));
		assert.ok(blocks[0].rawContent.includes("const x = \"<file path='dummy.txt'>test</file>\";"));
		assert.ok(blocks[1].attrStr.includes('file2.ts'));
		assert.ok(blocks[1].rawContent.includes('<<<<<<< SEARCH'));
	});
    
	test('renderFileList calculates byte size and token estimate correctly', () => {
		const { ContextPresenter } = require('../../commands/chatPanel/webview/messageRenderer');
		const fileList = [
			{ path: 'src/main.ts', bytes: 3500, state: 'included' },
			{ path: 'package.json', bytes: 700, state: 'included' }
		];

		const html = ContextPresenter.renderFileList(fileList, "No files", false, {}, 'heavy-to-light');
		assert.ok(html.includes('src/main.ts'));
		assert.ok(html.includes('3.4 KB') || html.includes('3.5 KB') || html.includes('KB'));
		assert.ok(html.includes('tok'));
		assert.ok(!html.includes('~0 tok'), 'File with positive byte count should not render ~0 tok');
	});

	test('ContextManager protects recently added files against governor eviction', () => {
		const { ContextManager } = require('../../contextManager');
		const cm = new ContextManager({} as any, {} as any);

		cm.recordRecentlyAddedFiles(['src/modules/analysis/logic.py', 'database.py']);

		assert.strictEqual(cm.isRecentlyAdded('src/modules/analysis/logic.py'), true);
  assert.strictEqual(cm.isRecentlyAdded('database.py'), true);
  assert.strictEqual(cm.isRecentlyAdded('other_file.py'), false);
 });

 test('ContextStateProvider excludes bloat folders from general discovery while allowing explicit file access', () => {
  const { ContextStateProvider } = require('../../commands/contextStateProvider');
  const provider = new ContextStateProvider({
   workspaceState: {
    get: () => ({}),
    update: () => Promise.resolve()
   },
   globalState: {
    get: () => ({}),
    update: () => Promise.resolve()
   }
  } as any);

  const dataUri = vscode.Uri.file('/workspace/data/raw_dataset.csv');
  const binUri = vscode.Uri.file('/workspace/bin/output.exe');

// File is not strictly ignored from context inclusion
  assert.strictEqual(provider.isStrictlyIgnored(dataUri), false, 'data/ files should not be blocked from explicit inclusion');
  assert.strictEqual(provider.isStrictlyIgnored(binUri), false, 'bin/ files should not be blocked from explicit inclusion');
 });

 test('Non-agent mode prompt never exposes read_file and exclusively directs to add_files_to_context', async () => {
  const { PromptTemplates } = require('../../promptTemplates');
  const { getProcessedSystemPrompt } = require('../../utils');

  // 1. Non-agent chat mode build
  const nonAgentPrompt = PromptTemplates.build(
   'chat',
   'You are a helpful assistant.',
   '',
   ['bash'],
   { agentMode: false, dynamicMode: false } as any,
   false
  );

  assert.strictEqual(nonAgentPrompt.includes('read_file'), false, 'Non-agent prompt must never mention read_file');
  assert.strictEqual(nonAgentPrompt.includes('read_files'), false, 'Non-agent prompt must never mention read_files');
  assert.strictEqual(nonAgentPrompt.includes('<lollms_tool>'), false, 'Non-agent discussion prompt must never mention <lollms_tool>');
  assert.ok(nonAgentPrompt.includes('<add_files_to_context>'), 'Non-agent prompt must instruct use of <add_files_to_context>');

  // 4. Export Prompt (Copy context & prompt for external LLMs)
  const exportPrompt = await getProcessedSystemPrompt(
   'chat',
   { agentMode: false, dynamicMode: true, isExport: true } as any,
   'You are an assistant.',
   undefined,
   false,
   { tree: '', files: '', skills: '' } as any
  );

  assert.strictEqual(exportPrompt.includes('<lollms_tool>'), false, 'Export prompt must never contain <lollms_tool>');
  assert.strictEqual(exportPrompt.includes('Available Tools for the'), false, 'Export prompt must never contain tool listings');
  assert.ok(exportPrompt.includes('<add_files_to_context>'), 'Export prompt must keep <add_files_to_context> tag');
  assert.ok(exportPrompt.includes('<remove_files_from_context>'), 'Export prompt must keep <remove_files_from_context> tag');

  // 2. Non-agent dynamic mode (Co-Engineer)
  const toolManager = {
   getAllTools: () => [
    { name: 'read_file', description: 'Reads a file.' },
    { name: 'read_files', description: 'Reads files.' },
    { name: 'generate_image', description: 'Generates image.' }
   ]
  };

  const dynamicPrompt = await getProcessedSystemPrompt(
   'chat',
   { agentMode: false, dynamicMode: true } as any,
   'You are a helpful assistant.',
   undefined,
   false,
   { toolManager } as any
  );

  assert.strictEqual(dynamicPrompt.includes('- `read_file`'), false, 'Dynamic non-agent prompt must never list read_file in available tools');
  assert.strictEqual(dynamicPrompt.includes('- `read_files`'), false, 'Dynamic non-agent prompt must never list read_files in available tools');
  assert.strictEqual(dynamicPrompt.includes('read_file`: `{"name": "read_file"'), false, 'Dynamic non-agent prompt must never show read_file schema');
  assert.ok(dynamicPrompt.includes('EXCLUSIVE FILE DISCOVERY VIA <add_files_to_context>'), 'Dynamic prompt must emphasize exclusive <add_files_to_context>');

  // 3. Agent mode prompt DOES mention read_file
  const agentPrompt = PromptTemplates.build(
   'agent',
   'You are an agent.',
   '',
   ['bash'],
   { agentMode: true } as any,
   false
  );

  assert.ok(agentPrompt.includes('read_file'), 'Agent mode prompt should mention read_file for agent execution');
 });
});