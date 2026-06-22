import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
    try {
        // The folder containing the Extension Manifest package.json
        // Passed to the runner to locate activation events
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');

        // The path to test runner passed to the VS Code instance
        const extensionTestsPath = path.resolve(__dirname, './suite/index');

        // Download VS Code, unzip it and run the integration test
        await runTests({ 
            version: '1.92.0', // Pin an isolated, stable version to bypass the local 1.125.1 update lock
            extensionDevelopmentPath, 
            extensionTestsPath,
            launchArgs: [
                '--disable-updates',
                '--disable-workspace-trust',
                '--disable-gpu'
            ]
        });
    } catch (err) {
        console.error('Failed to run tests');
        process.exit(1);
    }
}

main();
