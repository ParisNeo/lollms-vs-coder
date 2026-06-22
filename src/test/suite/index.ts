import * as path from 'path';
import { glob } from 'glob';
const Mocha = require('mocha');

export function run(): Promise<void> {
    // Create the mocha test runner instance
    // Self-healing constructor resolver to prevent esbuild interop compilation blocks
    const mocha = new (Mocha.default || Mocha)({
        ui: 'bdd', // Use standard Behavior-Driven Development interface
        color: true,
        timeout: 15000
    });

    const testsRoot = path.resolve(__dirname, '..');

    return new Promise((c, e) => {
        // Find all files ending with .test.js in our build directory
        glob('**/**.test.js', { cwd: testsRoot }, (err, files) => {
            if (err) {
                return e(err);
            }

            // Add files to the mocha instance
            files.forEach(f => mocha.addFile(path.resolve(testsRoot, f)));

            try {
                // Run the mocha test suite
                mocha.run(failures => {
                    if (failures > 0) {
                        e(new Error(`${failures} tests failed.`));
                    } else {
                        c();
                    }
                });
            } catch (err) {
                console.error(err);
                e(err);
            }
        });
    });
}
