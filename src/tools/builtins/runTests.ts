import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { ToolDefinition, ToolExecutionEnv } from '../tool';
import { AgentSecurityGuard } from '../../security/agentSecurityGuard';
import { stripAnsiCodes } from '../../utils';

export type SupportedTestRunner =
    | 'auto'
    | 'pytest'
    | 'unittest'
    | 'vitest'
    | 'jest'
    | 'mocha'
    | 'npm'
    | 'go'
    | 'cargo';

const TEST_DIR_NAMES = new Set([
    'test',
    'tests',
    'spec',
    'specs',
    '__tests__',
    'testing',
    'e2e',
    'integration',
    'unit',
    'test_suite',
    'testsuite',
    'tests_unit',
    'tests_integration'
]);

const TEST_FILE_PATTERNS: RegExp[] = [
    /^test_.*\.(?:py|ts|js|tsx|jsx|mjs|cjs|go|rs|rb|php)$/i,
    /.*_test\.(?:py|go|rs|rb|ts|js|php)$/i,
    /.*\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs|py)$/i,
    /.*(?:Test|Tests|Spec|Specs)\.(?:java|cs|kt|swift|cpp|cc|c)$/,
    /.*_spec\.rb$/i
];

const SHELL_META_REGEX = /[;&|`$<>!\r\n\0]/;
const SAFE_FILTER_REGEX = /^[a-zA-Z0-9_.\- ()]+$/;

function isTestDirSegment(segment: string): boolean {
    const lower = segment.toLowerCase();
    return (
        TEST_DIR_NAMES.has(lower) ||
        /^tests?[_-]/i.test(lower) ||
        /[_-]tests?$/i.test(lower)
    );
}

function isTestFileName(fileName: string): boolean {
    const lower = fileName.toLowerCase();
    if (lower === 'conftest.py' || lower === '__init__.py' || lower === 'package.json') {
        return false;
    }
    return TEST_FILE_PATTERNS.some(re => re.test(fileName));
}

function parseTargetsInput(params: any): string[] {
    const raw = params?.targets ?? params?.files ?? params?.paths ?? params?.path ?? params?.file ?? '';
    const items: string[] = [];

    const add = (val: string) => {
        const cleaned = String(val || '').trim().replace(/^['"`]|['"`]$/g, '').trim();
        if (cleaned && !items.includes(cleaned)) {
            items.push(cleaned);
        }
    };

    if (Array.isArray(raw)) {
        raw.forEach(item => {
            if (typeof item === 'string') {
                item.split(/[\r\n,]+/).forEach(add);
            }
        });
    } else if (typeof raw === 'string') {
        raw.split(/[\r\n,]+/).forEach(add);
    }

    return items;
}

async function resolveAndValidateTestTarget(
    rawTarget: string,
    env: ToolExecutionEnv
): Promise<{ ok: true; relativePath: string; fsPath: string; isDir: boolean; folder: vscode.WorkspaceFolder } | { ok: false; error: string }> {
    if (!env.workspaceRoot) {
        return { ok: false, error: 'No active workspace folder.' };
    }

    if (rawTarget.startsWith('-')) {
        return { ok: false, error: `Invalid target '${rawTarget}': CLI flags are not permitted in targets.` };
    }

    if (SHELL_META_REGEX.test(rawTarget)) {
        return { ok: false, error: `Security violation: Target '${rawTarget}' contains disallowed characters.` };
    }

    const pathCheck = AgentSecurityGuard.validateWorkspacePath(rawTarget, env.workspaceRoot);
    if (!pathCheck.valid) {
        return { ok: false, error: `Security violation for '${rawTarget}': ${pathCheck.reason}` };
    }

    const res = await env.contextManager.resolveWorkspaceFromPath(rawTarget);
    if (!res || !res.folder) {
        return { ok: false, error: `Target '${rawTarget}' could not be resolved inside the workspace.` };
    }

    const resolvedReal = path.resolve(res.uri.fsPath);
    const rootReal = path.resolve(res.folder.uri.fsPath);
    const isWin = process.platform === 'win32';
    const withinRoot = isWin
        ? resolvedReal.toLowerCase() === rootReal.toLowerCase() || resolvedReal.toLowerCase().startsWith(rootReal.toLowerCase() + path.sep)
        : resolvedReal === rootReal || resolvedReal.startsWith(rootReal + path.sep);

    if (!withinRoot) {
        return { ok: false, error: `Security violation: '${rawTarget}' resolves outside the workspace root.` };
    }

    let stat: vscode.FileStat;
    try {
        stat = await vscode.workspace.fs.stat(res.uri);
    } catch {
        return { ok: false, error: `Test target not found on disk: '${rawTarget}'.` };
    }

    const relNorm = res.relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!relNorm || relNorm === '.') {
        return { ok: false, error: `Target '${rawTarget}' cannot be the workspace root. Specify a test folder (e.g. 'tests') or specific test file(s).` };
    }

    const segments = relNorm.split('/').filter(Boolean);
    const isDir = stat.type === vscode.FileType.Directory;

    if (isDir) {
        const hasTestDirSegment = segments.some(isTestDirSegment);
        let containsDirectTestFiles = false;
        if (!hasTestDirSegment) {
            try {
                const entries = await vscode.workspace.fs.readDirectory(res.uri);
                containsDirectTestFiles = entries.some(([name, type]) => type === vscode.FileType.File && isTestFileName(name));
            } catch {}
        }

        if (!hasTestDirSegment && !containsDirectTestFiles) {
            return {
                ok: false,
                error: `Test-only policy violation: Directory '${relNorm}' is not a test folder and contains no test files. Specify a test directory (e.g. 'tests') or test file.`
            };
        }

        return { ok: true, relativePath: relNorm, fsPath: resolvedReal, isDir: true, folder: res.folder };
    }

    const fileName = segments[segments.length - 1] || '';
    const parentInTestDir = segments.slice(0, -1).some(isTestDirSegment);
    if (!isTestFileName(fileName) && !(parentInTestDir && fileName.toLowerCase() !== 'conftest.py' && fileName.toLowerCase() !== '__init__.py')) {
        return {
            ok: false,
            error: `Test-only policy violation: '${relNorm}' is not a recognized test file. This tool ONLY runs tests (e.g. 'tests', 'tests/test_file.py', 'src/app.test.ts').`
        };
    }

    return { ok: true, relativePath: relNorm, fsPath: resolvedReal, isDir: false, folder: res.folder };
}

async function resolvePythonExecutable(cwd: string, env: ToolExecutionEnv): Promise<string> {
    const isWin = process.platform === 'win32';
    const fromSession = env.agentManager?.sessionState?.projectEnvironments?.[cwd];
    if (fromSession) {
        const candidate = isWin
            ? path.join(path.isAbsolute(fromSession) ? fromSession : path.join(cwd, fromSession), 'Scripts', 'python.exe')
            : path.join(path.isAbsolute(fromSession) ? fromSession : path.join(cwd, fromSession), 'bin', 'python');
        if (fs.existsSync(candidate)) return candidate;
    }

    const pythonCfg = vscode.workspace.getConfiguration('python', vscode.Uri.file(cwd));
    const configuredInterp = pythonCfg.get<string>('defaultInterpreterPath');
    if (configuredInterp && configuredInterp !== 'python' && fs.existsSync(configuredInterp)) {
        return configuredInterp;
    }

    for (const venvName of ['.venv', 'venv', 'env']) {
        const candidate = isWin
            ? path.join(cwd, venvName, 'Scripts', 'python.exe')
            : path.join(cwd, venvName, 'bin', 'python');
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return isWin ? 'python' : 'python3';
}

async function detectRunner(
    requestedRunner: string | undefined,
    targets: { relativePath: string; isDir: boolean }[],
    cwd: string
): Promise<Exclude<SupportedTestRunner, 'auto'>> {
    const normalized = (requestedRunner || 'auto').toLowerCase().trim();
    if (['pytest', 'unittest', 'vitest', 'jest', 'mocha', 'npm', 'go', 'cargo'].includes(normalized)) {
        return normalized as Exclude<SupportedTestRunner, 'auto'>;
    }

    const hasPy = targets.some(t => t.relativePath.toLowerCase().endsWith('.py'));
    const hasJsTs = targets.some(t => /\.(?:js|ts|jsx|tsx|mjs|cjs)$/i.test(t.relativePath));
    const hasGo = targets.some(t => t.relativePath.toLowerCase().endsWith('.go'));
    const hasRs = targets.some(t => t.relativePath.toLowerCase().endsWith('.rs'));

    if (hasPy) return 'pytest';
    if (hasGo) return 'go';
    if (hasRs) return 'cargo';

    const pkgPath = path.join(cwd, 'package.json');
    let pkg: any = null;
    if (fs.existsSync(pkgPath)) {
        try {
            pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        } catch {}
    }

    if (hasJsTs || (pkg && !fs.existsSync(path.join(cwd, 'pytest.ini')) && !fs.existsSync(path.join(cwd, 'pyproject.toml')))) {
        const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
        if (deps.vitest || fs.existsSync(path.join(cwd, 'node_modules', 'vitest', 'vitest.mjs'))) return 'vitest';
        if (deps.jest || fs.existsSync(path.join(cwd, 'node_modules', 'jest', 'bin', 'jest.js'))) return 'jest';
        if (deps.mocha || fs.existsSync(path.join(cwd, 'node_modules', 'mocha', 'bin', 'mocha.js'))) return 'mocha';
        if (pkg?.scripts?.test) return 'npm';
    }

    if (fs.existsSync(path.join(cwd, 'go.mod'))) return 'go';
    if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return 'cargo';

    return 'pytest';
}

function buildRunnerCommand(
    runner: Exclude<SupportedTestRunner, 'auto'>,
    pythonExe: string,
    cwd: string,
    targetRelPaths: string[],
    filter?: string
): { executable: string; args: string[]; displayCmd: string } {
    const isWin = process.platform === 'win32';
    const filterArgs = (flag: string) => (filter ? [flag, filter] : []);

    switch (runner) {
        case 'pytest': {
            const args = ['-m', 'pytest', ...targetRelPaths, '-v', ...filterArgs('-k')];
            return { executable: pythonExe, args, displayCmd: `pytest ${targetRelPaths.join(' ')} -v${filter ? ` -k "${filter}"` : ''}` };
        }
        case 'unittest': {
            const args = ['-m', 'unittest', ...targetRelPaths, '-v', ...filterArgs('-k')];
            return { executable: pythonExe, args, displayCmd: `python -m unittest ${targetRelPaths.join(' ')} -v` };
        }
        case 'vitest': {
            const localEntry = path.join(cwd, 'node_modules', 'vitest', 'vitest.mjs');
            if (fs.existsSync(localEntry)) {
                const args = [localEntry, 'run', ...targetRelPaths, ...filterArgs('-t')];
                return { executable: 'node', args, displayCmd: `vitest run ${targetRelPaths.join(' ')}` };
            }
            const cmdArgs = ['vitest', 'run', ...targetRelPaths, ...filterArgs('-t')];
            return isWin
                ? { executable: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', 'npx', ...cmdArgs], displayCmd: `npx ${cmdArgs.join(' ')}` }
                : { executable: 'npx', args: cmdArgs, displayCmd: `npx ${cmdArgs.join(' ')}` };
        }
        case 'jest': {
            const localEntry = path.join(cwd, 'node_modules', 'jest', 'bin', 'jest.js');
            if (fs.existsSync(localEntry)) {
                const args = [localEntry, ...targetRelPaths, ...filterArgs('-t')];
                return { executable: 'node', args, displayCmd: `jest ${targetRelPaths.join(' ')}` };
            }
            const cmdArgs = ['jest', ...targetRelPaths, ...filterArgs('-t')];
            return isWin
                ? { executable: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', 'npx', ...cmdArgs], displayCmd: `npx ${cmdArgs.join(' ')}` }
                : { executable: 'npx', args: cmdArgs, displayCmd: `npx ${cmdArgs.join(' ')}` };
        }
        case 'mocha': {
            const localEntry = path.join(cwd, 'node_modules', 'mocha', 'bin', 'mocha.js');
            if (fs.existsSync(localEntry)) {
                const args = [localEntry, ...targetRelPaths, ...filterArgs('--grep')];
                return { executable: 'node', args, displayCmd: `mocha ${targetRelPaths.join(' ')}` };
            }
            const cmdArgs = ['mocha', ...targetRelPaths, ...filterArgs('--grep')];
            return isWin
                ? { executable: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', 'npx', ...cmdArgs], displayCmd: `npx ${cmdArgs.join(' ')}` }
                : { executable: 'npx', args: cmdArgs, displayCmd: `npx ${cmdArgs.join(' ')}` };
        }
        case 'npm': {
            const npmArgs = ['test', '--', ...targetRelPaths, ...filterArgs('-t')];
            return isWin
                ? { executable: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', 'npm', ...npmArgs], displayCmd: `npm ${npmArgs.join(' ')}` }
                : { executable: 'npm', args: npmArgs, displayCmd: `npm ${npmArgs.join(' ')}` };
        }
        case 'go': {
            const goTargets = targetRelPaths.map(t => (t.startsWith('./') || t.endsWith('.go')) ? t : `./${t}`);
            const args = ['test', '-v', ...filterArgs('-run'), ...goTargets];
            return { executable: 'go', args, displayCmd: `go ${args.join(' ')}` };
        }
        case 'cargo': {
            const testNames = targetRelPaths.map(t => path.basename(t, path.extname(t)));
            const args = ['test', ...(filter ? [filter] : testNames)];
            return { executable: 'cargo', args, displayCmd: `cargo ${args.join(' ')}` };
        }
    }
}

function spawnTestsProcess(
    executable: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal
): Promise<{ exitCode: number; output: string; timedOut: boolean; aborted: boolean; error?: string }> {
    return new Promise((resolve) => {
        const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
        let output = '';
        let truncated = false;
        let settled = false;
        let timedOut = false;
        let aborted = false;

        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(executable, args, {
                cwd,
                shell: false,
                env: {
                    ...process.env,
                    PYTHONIOENCODING: 'utf-8',
                    PYTHONUTF8: '1',
                    FORCE_COLOR: '0',
                    NO_COLOR: '1'
                }
            });
        } catch (err: any) {
            resolve({ exitCode: 1, output: '', timedOut: false, aborted: false, error: err?.message || String(err) });
            return;
        }

        const append = (chunk: Buffer | string) => {
            if (output.length >= MAX_CAPTURE_BYTES) {
                truncated = true;
                return;
            }
            output += chunk.toString();
        };

        child.stdout?.on('data', append);
        child.stderr?.on('data', append);

        const cleanup = () => {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
        };

        const finish = (code: number, errMsg?: string) => {
            if (settled) return;
            settled = true;
            cleanup();
            const cleanOut = stripAnsiCodes(output).trim() + (truncated ? '\n... [output exceeded 2MB buffer limit]' : '');
            resolve({ exitCode: code, output: cleanOut, timedOut, aborted, error: errMsg });
        };

        const onAbort = () => {
            aborted = true;
            try { child.kill(); } catch {}
            finish(1, 'Test execution cancelled by user.');
        };

        if (signal) {
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
        }

        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill(); } catch {}
            finish(1, `Test execution timed out after ${Math.round(timeoutMs / 1000)}s.`);
        }, timeoutMs);

        child.on('error', (err: any) => {
            finish(1, err?.message || String(err));
        });

        child.on('close', (code) => {
            finish(typeof code === 'number' ? code : 1);
        });
    });
}

export const runTestsTool: ToolDefinition = {
    name: "run_tests",
    description: "Executes project tests ONLY (never arbitrary commands) on the specified test file(s) or test folder(s), e.g., 'tests' or 'tests/test_auth.py'.",
    isAgentic: true,
    isDefault: true,
    permissionGroup: 'shell_execution',
    parameters: [
        {
            name: "targets",
            type: "array",
            description: "List of test file paths or test folder paths to run (e.g., ['tests'] or ['tests/test_auth.py']).",
            required: true
        },
        {
            name: "runner",
            type: "string",
            description: "Optional test runner: 'auto', 'pytest', 'unittest', 'vitest', 'jest', 'mocha', 'npm', 'go', 'cargo'. Defaults to 'auto'.",
            required: false
        },
        {
            name: "filter",
            type: "string",
            description: "Optional test name filter expression (e.g., 'test_login').",
            required: false
        },
        {
            name: "timeout_s",
            type: "number",
            description: "Optional timeout in seconds (default: 120, max: 600).",
            required: false
        }
    ],
    manualTagFormat: `<run_tests targets="tests" />`,
    async execute(
        params: { targets?: string[] | string; files?: string[] | string; paths?: string[] | string; path?: string; file?: string; runner?: string; filter?: string; timeout_s?: number },
        env: ToolExecutionEnv,
        signal: AbortSignal
    ): Promise<{ success: boolean; output: string }> {
        if (!env.workspaceRoot) {
            return { success: false, output: "Error: No active workspace folder." };
        }

        const rawTargets = parseTargetsInput(params);
        if (rawTargets.length === 0) {
            return {
                success: false,
                output: "Error: 'targets' is required. Specify at least one test file or test folder (e.g. 'tests' or 'tests/test_example.py')."
            };
        }

        const filter = typeof params?.filter === 'string' ? params.filter.trim() : undefined;
        if (filter && (!SAFE_FILTER_REGEX.test(filter) || SHELL_META_REGEX.test(filter))) {
            return {
                success: false,
                output: "Security violation: 'filter' contains disallowed characters. Only alphanumeric, spaces, dots, underscores, hyphens, and parentheses are allowed."
            };
        }

        const validatedTargets: { relativePath: string; fsPath: string; isDir: boolean; folder: vscode.WorkspaceFolder }[] = [];
        for (const rawTarget of rawTargets) {
            const check = await resolveAndValidateTestTarget(rawTarget, env);
            if (!check.ok) {
                return { success: false, output: `🛑 ${check.error}` };
            }
            validatedTargets.push({
                relativePath: check.relativePath,
                fsPath: check.fsPath,
                isDir: check.isDir,
                folder: check.folder
            });
        }

        const cwd = validatedTargets[0].folder.uri.fsPath;
        const targetRelPaths = validatedTargets.map(t => t.relativePath);
        const runner = await detectRunner(params?.runner, validatedTargets, cwd);
        const pythonExe = (runner === 'pytest' || runner === 'unittest')
            ? await resolvePythonExecutable(cwd, env)
            : 'python';

        const { executable, args, displayCmd } = buildRunnerCommand(runner, pythonExe, cwd, targetRelPaths, filter);
        const timeoutSeconds = Math.min(600, Math.max(5, Number(params?.timeout_s) || 120));
        const startTime = Date.now();

        const res = await spawnTestsProcess(executable, args, cwd, timeoutSeconds * 1000, signal);
        const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);

        if (res.error && !res.output) {
            return {
                success: false,
                output: `❌ Failed to execute test runner (${displayCmd}): ${res.error}`
            };
        }

        let bodyOutput = res.output || '(No test output produced)';
        if (bodyOutput.length > 12000) {
            bodyOutput = `${bodyOutput.substring(0, 2000)}\n\n... [truncated ${bodyOutput.length - 12000} middle chars] ...\n\n${bodyOutput.substring(bodyOutput.length - 10000)}`;
        }

        const passed = res.exitCode === 0 && !res.timedOut && !res.aborted && !res.error;
        const statusBanner = passed
            ? `✅ TESTS PASSED (Exit Code: 0 | ${elapsedSec}s)`
            : `❌ TESTS FAILED (Exit Code: ${res.exitCode} | ${elapsedSec}s${res.error ? ` | ${res.error}` : ''})`;

        return {
            success: passed,
            output: `${statusBanner}\nCommand: \`${displayCmd}\`\n\`\`\`text\n${bodyOutput}\n\`\`\``
        };
    }
};