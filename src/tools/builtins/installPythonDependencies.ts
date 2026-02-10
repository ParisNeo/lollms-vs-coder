import { ToolDefinition, ToolExecutionEnv } from '../tool';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';

// Common mappings from import name to pip package name
const PACKAGE_MAPPINGS: { [key: string]: string } = {
    'PIL': 'Pillow',
    'cv2': 'opencv-python',
    'yaml': 'PyYAML',
    'bs4': 'beautifulsoup4',
    'sklearn': 'scikit-learn',
    'dotenv': 'python-dotenv',
    'discord': 'discord.py',
    'googleapiclient': 'google-api-python-client',
    'protobuf': 'protobuf',
    'dateutil': 'python-dateutil',
    'flask_cors': 'Flask-Cors',
    'flask_sqlalchemy': 'Flask-SQLAlchemy',
    'telegram': 'discord.py', // Common confusion, though discord.py is usually what people mean for bots unless using telegram bot api
    'lollms_client': 'lollms-client'
};

// A non-exhaustive but comprehensive list of Python 3 standard libraries to exclude
const STD_LIB = new Set([
    'abc', 'aifc', 'argparse', 'array', 'ast', 'asynchat', 'asyncio', 'asyncore', 'atexit', 'audioop',
    'base64', 'bdb', 'binascii', 'binhex', 'bisect', 'builtins', 'bz2', 'calendar', 'cgi', 'cgitb',
    'chunk', 'cmath', 'cmd', 'code', 'codecs', 'codeop', 'collections', 'colorsys', 'compileall',
    'concurrent', 'configparser', 'contextlib', 'contextvars', 'copy', 'copyreg', 'cProfile',
    'crypt', 'csv', 'ctypes', 'curses', 'dataclasses', 'datetime', 'dbm', 'decimal', 'difflib',
    'dis', 'distutils', 'doctest', 'dummy_threading', 'email', 'encodings', 'ensurepip', 'enum',
    'errno', 'faulthandler', 'fcntl', 'filecmp', 'fileinput', 'fnmatch', 'formatter', 'fractions',
    'ftplib', 'functools', 'gc', 'getopt', 'getpass', 'gettext', 'glob', 'graphlib', 'grp', 'gzip',
    'hashlib', 'heapq', 'hmac', 'html', 'http', 'imaplib', 'imghdr', 'imp', 'importlib', 'inspect',
    'io', 'ipaddress', 'itertools', 'json', 'keyword', 'lib2to3', 'linecache', 'locale', 'logging',
    'lzma', 'mailbox', 'mailcap', 'marshal', 'math', 'mimetypes', 'mmap', 'modulefinder', 'msilib',
    'msvcrt', 'multiprocessing', 'netrc', 'nis', 'nntplib', 'numbers', 'operator', 'optparse', 'os',
    'ossaudiodev', 'parser', 'pathlib', 'pdb', 'pickle', 'pickletools', 'pipes', 'pkgutil', 'platform',
    'plistlib', 'poplib', 'posix', 'pprint', 'profile', 'pstats', 'pty', 'pwd', 'py_compile', 'pyclbr',
    'pydoc', 'queue', 'quopri', 'random', 're', 'readline', 'reprlib', 'resource', 'rlcompleter',
    'runpy', 'sched', 'secrets', 'select', 'selectors', 'shelve', 'shlex', 'shutil', 'signal', 'site',
    'smtpd', 'smtplib', 'sndhdr', 'socket', 'socketserver', 'spwd', 'sqlite3', 'ssl', 'stat', 'statistics',
    'string', 'stringprep', 'struct', 'subprocess', 'sunau', 'symbol', 'symtable', 'sys', 'sysconfig',
    'syslog', 'tabnanny', 'tarfile', 'telnetlib', 'tempfile', 'termios', 'textwrap', 'threading', 'time',
    'timeit', 'tkinter', 'token', 'tokenize', 'trace', 'traceback', 'tracemalloc', 'tty', 'turtle',
    'turtledemo', 'types', 'typing', 'unicodedata', 'unittest', 'urllib', 'uu', 'uuid', 'venv', 'warnings',
    'wave', 'weakref', 'webbrowser', 'winreg', 'winsound', 'wsgiref', 'xdrlib', 'xml', 'xmlrpc', 'zipapp',
    'zipfile', 'zipimport', 'zlib', 'zoneinfo'
]);

export const installPythonDependenciesTool: ToolDefinition = {
    name: "install_python_dependencies",
    description: "Installs packages via pip. If no dependencies are provided, it checks for requirements.txt. If that is missing, it SCANS the workspace python files to auto-detect imports.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "env_name", type: "string", description: "Venv folder name.", required: true },
        { name: "dependencies", type: "array", description: "List of package names strings. Leave empty to auto-detect from requirements.txt or source code.", required: true }
    ],
    async execute(params: { env_name: string, dependencies: string[] }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        const pythonExec = os.platform() === 'win32'
            ? path.join(params.env_name, 'Scripts', 'python.exe')
            : path.join(params.env_name, 'bin', 'python');

        // Check if venv exists first
        if (!env.workspaceRoot) return { success: false, output: "No workspace." };
        const rootPath = env.workspaceRoot.uri.fsPath;
        const venvPath = path.join(rootPath, params.env_name);
        
        try {
            await fs.access(venvPath);
        } catch {
            return { success: false, output: `Virtual environment '${params.env_name}' not found. Please create it first.` };
        }

        let command = "";
        let detectedDeps: string[] = [];
        
        if (!params.dependencies || params.dependencies.length === 0) {
            // 1. Check for requirements.txt
            const reqPath = path.join(rootPath, 'requirements.txt');
            let hasReq = false;
            try {
                await fs.access(reqPath);
                hasReq = true;
            } catch {}

            if (hasReq) {
                command = `"${pythonExec}" -m pip install -r requirements.txt`;
            } else {
                // 2. Auto-Scan Logic
                env.agentManager?.ui.addMessageToDiscussion({ 
                    role: 'system', 
                    content: '🔍 **Scanning workspace for Python imports...**' 
                });

                detectedDeps = await scanForImports(rootPath, [params.env_name, 'node_modules', '.git', '__pycache__']);
                
                if (detectedDeps.length === 0) {
                    return { success: true, output: "No external dependencies found in python files, and no requirements.txt exists. Nothing to install." };
                }

                // Create requirements.txt
                const reqContent = detectedDeps.join('\n');
                await fs.writeFile(reqPath, reqContent);
                
                env.agentManager?.ui.addMessageToDiscussion({ 
                    role: 'system', 
                    content: `📝 **Generated requirements.txt** with:\n${detectedDeps.map(d => `- ${d}`).join('\n')}` 
                });

                command = `"${pythonExec}" -m pip install -r requirements.txt`;
            }
        } else {
            const deps = params.dependencies.join(' ');
            command = `"${pythonExec}" -m pip install ${deps}`;
        }

        const result = await env.agentManager!.runCommand(command, signal);

        if (!result.success) {
            let helpfulError = result.output;
            if (result.output.includes("Retrying") || result.output.includes("timeout")) {
                helpfulError = "NETWORK ERROR: Pip timed out. Check your internet connection or try a different mirror.";
            } else if (result.output.includes("No module named pip")) {
                helpfulError = "ENVIRONMENT ERROR: 'pip' is not installed in this venv. You may need to create it with --with-pip.";
            }
            return { success: false, output: helpfulError };
        }

        return result;
    }
};

async function scanForImports(rootPath: string, excludeDirs: string[]): Promise<string[]> {
    const imports = new Set<string>();
    
    async function walk(dir: string) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!excludeDirs.includes(entry.name) && !entry.name.startsWith('.')) {
                    await walk(fullPath);
                }
            } else if (entry.isFile() && entry.name.endsWith('.py')) {
                const content = await fs.readFile(fullPath, 'utf-8');
                extractImportsFromContent(content).forEach(i => imports.add(i));
            }
        }
    }

    try {
        await walk(rootPath);
    } catch (e) {
        console.error("Error scanning files:", e);
    }

    // Filter and Map
    const packages = new Set<string>();
    imports.forEach(imp => {
        const rootModule = imp.split('.')[0];
        if (!STD_LIB.has(rootModule) && rootModule !== 'lollms_client') { // lollms_client is handled via mapping but good to exclude loop
             const pkgName = PACKAGE_MAPPINGS[rootModule] || rootModule;
             packages.add(pkgName);
        }
    });

    return Array.from(packages).sort();
}

function extractImportsFromContent(content: string): string[] {
    const found = new Set<string>();
    const lines = content.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        // import X
        const importMatch = trimmed.match(/^import\s+([\w, ]+)/);
        if (importMatch) {
            const modules = importMatch[1].split(',').map(s => s.trim());
            modules.forEach(m => found.add(m.split(' ')[0])); // handle 'import numpy as np'
        }
        // from X import Y
        const fromMatch = trimmed.match(/^from\s+([\w.]+)\s+import/);
        if (fromMatch) {
            found.add(fromMatch[1]);
        }
    }
    return Array.from(found);
}
