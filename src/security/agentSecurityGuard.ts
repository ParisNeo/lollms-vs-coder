import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { URL } from 'url';
import { DiscussionCapabilities } from '../utils';
import { Logger } from '../logger';

export type AgentSecurityLevel = 'strict' | 'guarded' | 'relaxed';

export interface AgentMutationRecord {
    id: string;
    timestamp: number;
    tool: string;
    filePath: string;
    uriString: string;
    action: 'create' | 'modify' | 'delete' | 'move';
    backupPath?: string;
    destinationUriString?: string;
    destinationPath?: string;
    existedBefore: boolean;
    reverted?: boolean;
}

export interface SecurityAuditEntry {
    timestamp: number;
    verdict: 'allowed' | 'confirmed' | 'blocked';
    tool: string;
    target: string;
    reason: string;
}

export interface CommandAnalysisResult {
    decision: 'allow' | 'confirm' | 'block';
    reason: string;
    severity: 'low' | 'high' | 'critical';
}

export interface ContentValidationResult {
    valid: boolean;
    requiresConfirmation: boolean;
    reason?: string;
}

const CATASTROPHIC_COMMAND_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
    { regex: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*\s+(?:\/|~|\*|\.\.?\/?(?:\s|$)|[A-Za-z]:\\)/, reason: 'Catastrophic recursive force deletion targeting root, home, parent, or wildcard.' },
    { regex: /\brm\s+-[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*\s+(?:\/|~|\*|\.\.?\/?(?:\s|$)|[A-Za-z]:\\)/, reason: 'Catastrophic recursive force deletion targeting root, home, parent, or wildcard.' },
    { regex: /\b(?:rd|rmdir)\s+\/s\s+\/q\s+(?:[A-Za-z]:\\|\\|\.\.?|\*|\.)(?:\s|$)/i, reason: 'Catastrophic Windows recursive directory wipe.' },
    { regex: /\bdel\s+(?:\/[fFsSqQ]\s+)+(?:\*|\.\*|[A-Za-z]:\\|\\)/i, reason: 'Catastrophic Windows wildcard file wipe.' },
    { regex: /\bRemove-Item\b[^\n]*(?:-Recurse|-r)[^\n]*(?:\bC:\\|\b\/|\*|\.\.?\\|\s\.\s)/i, reason: 'Catastrophic PowerShell recursive deletion.' },
    { regex: /\b(?:mkfs|fdisk|diskpart|format\s+[A-Za-z]:|dd\s+if=.*of=\/dev\/)/i, reason: 'Disk formatting or raw block-device overwrite command.' },
    { regex: /\bgit\s+push\b[^\n]*(?:--force|-f\b)/i, reason: 'Force-pushing to remote Git repository is forbidden.' },
    { regex: /\bgit\s+reset\s+--hard\b/i, reason: 'Hard Git reset destroys uncommitted work and history.' },
    { regex: /\bgit\s+clean\s+-[a-zA-Z]*[fF][a-zA-Z]*[dD]/i, reason: 'git clean -fd permanently deletes untracked project files.' },
    { regex: /\bgit\s+clean\s+-[a-zA-Z]*[dD][a-zA-Z]*[fF]/i, reason: 'git clean -df permanently deletes untracked project files.' },
    { regex: /(?:^|\s|\/|\\)\.git(?:\/|\\|\s|$)/i, reason: 'Direct shell manipulation or deletion of .git metadata is forbidden.' },
    { regex: /(?:curl|wget)\s+[^\n|]+\|\s*(?:sudo\s+)?(?:ba)?sh\b/i, reason: 'Piping remote scripts directly into a shell is forbidden.' },
    { regex: /\bpowershell(?:\.exe)?\s+-[eE](?:nc|ncodedCommand)\s+[A-Za-z0-9+/=]{12,}/i, reason: 'Encoded PowerShell execution is blocked for security.' },
    { regex: /(?:~\/\.ssh|~\/\.aws|~\/\.kube|\/etc\/shadow|\/etc\/passwd|\bid_rsa\b)/i, reason: 'Access to host credentials or system authentication files is forbidden.' },
    { regex: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'Fork bomb pattern detected.' }
];

const RISKY_COMMAND_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
    { regex: /\b(?:rm|rmdir|unlink|shred)\b/i, reason: 'Shell command deletes files or directories.' },
    { regex: /\b(?:del|erase|rd)\s+/i, reason: 'Windows shell command deletes files or directories.' },
    { regex: /\bRemove-Item\b/i, reason: 'PowerShell Remove-Item deletes filesystem entries.' },
    { regex: /\bgit\s+(?:checkout\s+--|restore\b|branch\s+-D|rebase\b|filter-branch\b)/i, reason: 'Git command discards local changes or rewrites branch history.' },
    { regex: /\b(?:chmod|chown|icacls|takeown)\s+[^\n]*(?:-R|\/T)/i, reason: 'Recursive filesystem permission modification.' },
    { regex: /\b(?:python|python3|node)\s+-[ce]\s+[^\n]*(?:rmtree|rmSync|rmdirSync|unlink|os\.remove|os\.system|execSync)/i, reason: 'Inline script execution contains destructive filesystem or shell calls.' }
];

const SCRIPT_DESTRUCTIVE_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
    { regex: /\bshutil\.rmtree\s*\(/, reason: 'Recursive directory deletion via shutil.rmtree()' },
    { regex: /\bfs\.(?:rmSync|rmdirSync|promises\.rm)\s*\([^\n)]*recursive\s*:\s*true/, reason: 'Recursive directory deletion via fs.rmSync/rm()' },
    { regex: /\b(?:os\.remove|os\.unlink|fs\.unlinkSync)\s*\(/, reason: 'Direct file deletion inside script' },
    { regex: /\b(?:os\.system|subprocess\.(?:run|Popen|call|check_call)|execSync|spawnSync)\s*\([^\n)]*(?:\brm\s+-|\bdel\s+\/|\brd\s+\/s|git\s+reset\s+--hard)/i, reason: 'Subprocess executes destructive shell command' },
    { regex: /\b(?:os\.environ|os\.getenv|dotenv|load_dotenv|keyring|getpass|process\.env)\b/, reason: 'Script inspects environment variables or secrets' },
    { regex: /['"](?:\.env(?:\.|$)|id_rsa|id_ed25519|\.ssh|\.aws|\.kube)/i, reason: 'Script references credential or secret files' },
    { regex: /\b(?:subprocess\.(?:run|Popen|call|check_call|check_output)|os\.system|os\.popen|child_process\.(?:exec|execSync|spawn|spawnSync|execFile|execFileSync))\b/, reason: 'Script spawns external subprocesses or shell commands' }
];

const SCRIPT_HARD_BLOCK_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
    { regex: /\bos\.path\.expanduser\s*\(|\bos\.homedir\s*\(/, reason: 'Resolving user home directory outside the workspace is forbidden.' },
    { regex: /\b(?:os\.chdir|process\.chdir)\s*\(\s*[`'"]\s*(?:\.\.|\/|~|[A-Za-z]:[\\/])/, reason: 'Changing working directory outside the workspace is forbidden.' },
    { regex: /(?:open|Path|os\.listdir|os\.walk|os\.scandir|os\.chdir|shutil\.(?:copy|copy2|copytree|move|rmtree)|fs\.(?:readFile|readFileSync|writeFile|writeFileSync|appendFileSync|readdir|readdirSync|rm|rmSync|unlinkSync|mkdirSync|promises\.[a-zA-Z]+))\s*\(\s*(?:[rfbuRFBU]{0,2}[`'"]\s*(?:~|\.\.[\\/]|[A-Za-z]:[\\/]|\/(?!dev\/null\b))|path\.(?:join|resolve)\s*\([^)]*['"]\.\.)/, reason: 'Accessing filesystem paths outside the workspace is forbidden.' },
    { regex: /['"`][^'"`\r\n]*\.lollms[\\/](?:knowledge\.ttl|memory|briefing|discussions|external_links\.json)/i, reason: 'Modifying internal extension memory, briefing, or knowledge files during execution is forbidden.' },
    { regex: /(?:exec|eval)\s*\(\s*(?:base64\.b64decode|Buffer\.from|atob)\b/i, reason: 'Obfuscated base64 code execution is forbidden.' },
    { regex: /\bnew\s+Function\s*\(/, reason: 'Dynamic Function() execution is forbidden.' }
];

const NETWORK_CLI_REGEX = /(?:^|[;&|(\s])(?:curl(?:\.exe)?|wget(?:\.exe)?|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer|nc|ncat|netcat|socat|telnet|ssh|scp|sftp|ftp|lynx|w3m|xh)\b/i;
const SCRIPT_NETWORK_API_REGEX = /\b(?:requests\.(?:get|post|put|delete|patch|head|options|request|Session)|urllib\.request|urllib3|http\.client|httpx\.|aiohttp\.|pycurl\.|socket\.(?:socket|create_connection)|ftplib\.|smtplib\.|fetch\s*\(|axios(?:\.[a-z]+)?\s*\(|https?\.(?:get|request)\s*\(|net\.(?:connect|createConnection)\s*\(|tls\.connect\s*\(|dgram\.createSocket\s*\(|new\s+WebSocket\s*\(|new\s+XMLHttpRequest\s*\()/i;
const URL_SCHEME_REGEX = /\b(?:https?|ftp|sftp|wss?):\/\/[^\s'"`<>)]+/gi;
const PROTECTED_SYSTEM_PREFIXES = ['/etc/', '/var/', '/usr/', '/bin/', '/sbin/', '/root/', '/home/', '/opt/', '/proc/', '/sys/', 'c:/windows', 'c:/users/', 'c:/program files'];

export class AgentSecurityGuard {
    private mutations: AgentMutationRecord[] = [];
    private auditLog: SecurityAuditEntry[] = [];
    private mutatedFilesSinceCheckpoint: Set<string> = new Set();

    public getLevel(capabilities?: DiscussionCapabilities): AgentSecurityLevel {
        const capLevel = capabilities?.agentSecurityLevel;
        if (capLevel === 'strict' || capLevel === 'guarded' || capLevel === 'relaxed') {
            return capLevel;
        }
        const cfgLevel = vscode.workspace.getConfiguration('lollmsVsCoder').get<string>('agent.securityLevel', 'guarded');
        if (cfgLevel === 'strict' || cfgLevel === 'guarded' || cfgLevel === 'relaxed') {
            return cfgLevel;
        }
        return 'guarded';
    }

    public recordAudit(entry: Omit<SecurityAuditEntry, 'timestamp'>): void {
        this.auditLog.push({
            timestamp: Date.now(),
            ...entry
        });
        if (this.auditLog.length > 500) {
            this.auditLog.shift();
        }
    }

    public getAuditLog(): SecurityAuditEntry[] {
        return [...this.auditLog];
    }

    public getMutations(): AgentMutationRecord[] {
        return [...this.mutations];
    }

    public getActiveMutationCount(): number {
        return this.mutations.filter(m => !m.reverted).length;
    }

    public resetBlastRadiusCounter(): void {
        this.mutatedFilesSinceCheckpoint.clear();
    }

    public checkBlastRadius(targetPath: string, level: AgentSecurityLevel): { exceeded: boolean; count: number; limit: number } {
        const limit = level === 'strict' ? 5 : (level === 'guarded' ? 12 : 30);
        const norm = targetPath.replace(/\\/g, '/').toLowerCase().trim();
        if (!norm || this.mutatedFilesSinceCheckpoint.has(norm)) {
            return { exceeded: false, count: this.mutatedFilesSinceCheckpoint.size, limit };
        }
        const nextCount = this.mutatedFilesSinceCheckpoint.size + 1;
        return {
            exceeded: nextCount > limit,
            count: nextCount,
            limit
        };
    }

    public markFileMutated(targetPath: string): void {
        const norm = targetPath.replace(/\\/g, '/').toLowerCase().trim();
        if (norm) {
            this.mutatedFilesSinceCheckpoint.add(norm);
        }
    }

    private static resolveWorkspaceRoots(workspaceRoots?: string[]): string[] {
        const rawRoots = workspaceRoots && workspaceRoots.length > 0
            ? workspaceRoots
            : (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
        return rawRoots.filter(Boolean).map(r => {
            const resolved = path.resolve(r);
            try {
                return fs.realpathSync(resolved);
            } catch {
                return resolved;
            }
        });
    }

    private static isPathInsideRoots(candidatePath: string, resolvedRoots: string[]): boolean {
        if (!candidatePath || resolvedRoots.length === 0) return false;
        const isWin = process.platform === 'win32';
        let resolved = path.resolve(candidatePath);
        try {
            if (fs.existsSync(resolved)) {
                resolved = fs.realpathSync(resolved);
            }
        } catch {}

        return resolvedRoots.some(root => {
            const c = isWin ? resolved.toLowerCase() : resolved;
            const r = isWin ? root.toLowerCase() : root;
            return c === r || c.startsWith(r + path.sep);
        });
    }

    private static isLoopbackUrl(urlStr: string): boolean {
        try {
            const parsed = new URL(urlStr);
            const host = parsed.hostname.toLowerCase();
            return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
        } catch {
            return false;
        }
    }

    public static checkUnauthorizedWebCalls(text: string, isScript: boolean = false): { allowed: boolean; reason?: string } {
        if (!text) return { allowed: true };

        // 1. Check explicit URLs (http://, https://, ftp://, ws://, etc.)
        URL_SCHEME_REGEX.lastIndex = 0;
        const urls = text.match(URL_SCHEME_REGEX) || [];
        for (const u of urls) {
            if (!AgentSecurityGuard.isLoopbackUrl(u)) {
                return {
                    allowed: false,
                    reason: `Unauthorized external web call to '${u}' is forbidden during execution. Use the web search tool when enabled instead.`
                };
            }
        }

        // 2. Check network CLI clients (curl, wget, iwr, irm, nc, ssh, scp, etc.)
        if (NETWORK_CLI_REGEX.test(text)) {
            const hasOnlyLoopbackUrl = urls.length > 0 && urls.every(u => AgentSecurityGuard.isLoopbackUrl(u));
            if (!hasOnlyLoopbackUrl) {
                return {
                    allowed: false,
                    reason: 'Unauthorized network/web client command (curl/wget/iwr/nc/ssh/etc.) is blocked during execution. Use the web search tool when enabled instead.'
                };
            }
        }

        // 3. Check remote git / package URL installs
        if (/\b(?:git\s+(?:clone|fetch|pull|ls-remote)|(?:pip|pip3)\s+install\s+[^\r\n]*(?:git\+|https?:\/\/)|npm\s+install\s+[^\r\n]*(?:git\+|https?:\/\/))/i.test(text)) {
            return {
                allowed: false,
                reason: 'Remote repository/package network downloads are forbidden during execution.'
            };
        }

        // 4. Check programmatic HTTP/socket APIs inside scripts or inline execution
        if (isScript || /\b(?:python|python3|node)\s+-[ce]\b/i.test(text)) {
            if (SCRIPT_NETWORK_API_REGEX.test(text)) {
                const hasOnlyLoopbackUrl = urls.length > 0 && urls.every(u => AgentSecurityGuard.isLoopbackUrl(u));
                if (!hasOnlyLoopbackUrl) {
                    return {
                        allowed: false,
                        reason: 'Unauthorized programmatic web/socket call inside script is forbidden. Use the web search tool when enabled instead.'
                    };
                }
            }
        }

        return { allowed: true };
    }

    public static checkWorkspaceBoundaryInText(text: string, workspaceRoots?: string[]): { valid: boolean; reason?: string } {
        if (!text) return { valid: true };
        const roots = AgentSecurityGuard.resolveWorkspaceRoots(workspaceRoots);

        if (/(?:^|[;&|(\s])(?:cd|chdir|pushd|Set-Location|sl)\s+(?:\/|~|\.\.|[A-Za-z]:[\\/])/im.test(text)) {
            const cdMatch = text.match(/(?:^|[;&|(\s])(?:cd|chdir|pushd|Set-Location|sl)\s+(['"]?)([^'"\r\n;&|]+)\1/im);
            const target = cdMatch?.[2]?.trim() || '';
            if (!target || target.startsWith('~') || target.startsWith('..') || !AgentSecurityGuard.isPathInsideRoots(target, roots)) {
                return {
                    valid: false,
                    reason: `Changing directory outside the workspace ('${target || '..'}') is forbidden.`
                };
            }
        }

        if (/(?:^|[\s'"`=(,;:])\.\.(?:\/|\\|\s|$|['"`])/m.test(text)) {
            return {
                valid: false,
                reason: "Path traversal ('..') escaping the workspace is forbidden."
            };
        }

        if (/(?:~\/|~\\|\$HOME\b|\$\{HOME\}|\$env:(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA)\b|%(?:USERPROFILE|HOMEPATH|APPDATA|LOCALAPPDATA|WINDIR|SYSTEMROOT)%)/i.test(text)) {
            return {
                valid: false,
                reason: 'Accessing home directory or OS profile environment paths outside the workspace is forbidden.'
            };
        }

        if (/file:\/\/|\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9$._-]+/i.test(text)) {
            return {
                valid: false,
                reason: 'file:// URIs and UNC network paths are forbidden.'
            };
        }

        // Check protected system directories and external absolute paths
        const cleanedForPaths = text
            .replace(URL_SCHEME_REGEX, ' ')
            .replace(/(?:^|\s)--?[a-zA-Z0-9_-]+=/g, ' ');

        const absPathRegex = /(?:^|[\s'"`=(,;:])((?:[A-Za-z]:[\\/]|\/(?!(?:c|d|e|f|n|q|r|s|v|x|y|z)\b(?:\s|$)))[^\s'"`<>|;&,);]+)/g;
        let pm: RegExpExecArray | null;
        while ((pm = absPathRegex.exec(cleanedForPaths)) !== null) {
            const candidate = pm[1].trim();
            if (!candidate || candidate === '/dev/null' || candidate === '/') {
                if (candidate === '/') {
                    return { valid: false, reason: `Access to root path '/' outside the workspace is forbidden.` };
                }
                continue;
            }
            // Ignore common CLI flags like /s /q /f /c on Windows or regexes
            if (/^\/[a-zA-Z]{1,3}$/.test(candidate)) continue;

            const normCand = candidate.replace(/\\/g, '/').toLowerCase();
            if (PROTECTED_SYSTEM_PREFIXES.some(pref => normCand.startsWith(pref))) {
                return {
                    valid: false,
                    reason: `Access to system/external path '${candidate}' outside the workspace is forbidden.`
                };
            }

            if (path.isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)) {
                if (roots.length > 0 && !AgentSecurityGuard.isPathInsideRoots(candidate, roots)) {
                    return {
                        valid: false,
                        reason: `Access to absolute path '${candidate}' outside the workspace is forbidden.`
                    };
                }
            }
        }

        return { valid: true };
    }

    public static validateWorkspacePath(rawPath: string, workspaceRoot?: vscode.WorkspaceFolder): { valid: boolean; reason?: string } {
        const prot = AgentSecurityGuard.isProtectedPath(rawPath);
        if (prot.protected) {
            return { valid: false, reason: prot.reason };
        }
        const norm = rawPath.replace(/\\/g, '/').trim();
        if (norm.startsWith('\\\\') || norm.startsWith('//') || /^file:\/\//i.test(norm)) {
            return { valid: false, reason: `Network/UNC or file:// URI '${rawPath}' is forbidden.` };
        }
        if (path.isAbsolute(rawPath) || /^[a-zA-Z]:[\\/]/.test(rawPath)) {
            const roots = AgentSecurityGuard.resolveWorkspaceRoots(
                workspaceRoot ? [workspaceRoot.uri.fsPath] : undefined
            );
            if (!AgentSecurityGuard.isPathInsideRoots(rawPath, roots)) {
                return { valid: false, reason: `Access to full/absolute path '${rawPath}' outside the workspace is forbidden.` };
            }
        }
        return { valid: true };
    }

    public static isProtectedPath(rawPath: string): { protected: boolean; reason?: string } {
        if (!rawPath || typeof rawPath !== 'string') {
            return { protected: true, reason: 'Empty file path is forbidden.' };
        }
        const norm = rawPath.replace(/\\/g, '/').trim();
        const lower = norm.toLowerCase();

        if (!norm || norm === '.' || norm === './' || norm === '/' || norm === '..' || norm === '*') {
            return { protected: true, reason: `Targeting root or wildcard path '${rawPath}' is forbidden.` };
        }
        if (norm.includes('../') || norm.startsWith('..')) {
            return { protected: true, reason: `Path traversal ('..') in '${rawPath}' is forbidden.` };
        }
        if (lower === '.git' || lower.startsWith('.git/') || lower.includes('/.git/')) {
            return { protected: true, reason: `Modifying or deleting Git repository metadata ('${rawPath}') is forbidden.` };
        }
        if (lower === '.lollms' || (lower.startsWith('.lollms/') && !lower.startsWith('.lollms/sandbox/') && !lower.startsWith('.lollms/assets/') && lower !== '.lollms/last_test_log.log')) {
            return { protected: true, reason: `Modifying internal extension state ('${rawPath}') is protected.` };
        }
        const base = path.posix.basename(lower);
        if (base === '.env' || base.startsWith('.env.') || base.endsWith('.pem') || base.endsWith('.key') || base.startsWith('id_rsa') || base.startsWith('id_ed25519')) {
            return { protected: true, reason: `Credential/secret file ('${rawPath}') is protected against autonomous agent mutation.` };
        }
        return { protected: false };
    }

    public static analyzeShellCommand(command: string, level: AgentSecurityLevel, workspaceRoots?: string[]): CommandAnalysisResult {
        const cmd = (command || '').trim();
        if (!cmd) {
            return { decision: 'block', reason: 'Empty shell command.', severity: 'critical' };
        }

        for (const rule of CATASTROPHIC_COMMAND_PATTERNS) {
            if (rule.regex.test(cmd)) {
                return { decision: 'block', reason: rule.reason, severity: 'critical' };
            }
        }

        if (/(?:base64\s+(?:-d|--decode)\s*\|\s*(?:ba)?sh|\bInvoke-Expression\b|\biex\b\s+[^\r\n]*(?:http|iwr|irm|DownloadString))/i.test(cmd)) {
            return { decision: 'block', reason: 'Obfuscated or remote payload execution is forbidden.', severity: 'critical' };
        }

        if (/\.lollms[\\/](?:knowledge\.ttl|memory|briefing|discussions|external_links\.json)/i.test(cmd)) {
            return { decision: 'block', reason: 'Tampering with internal .lollms memory/briefing/knowledge files via shell is forbidden.', severity: 'critical' };
        }

        const boundaryCheck = AgentSecurityGuard.checkWorkspaceBoundaryInText(cmd, workspaceRoots);
        if (!boundaryCheck.valid) {
            return { decision: 'block', reason: boundaryCheck.reason || 'Workspace boundary violation.', severity: 'critical' };
        }

        const webCheck = AgentSecurityGuard.checkUnauthorizedWebCalls(cmd, false);
        if (!webCheck.allowed) {
            return { decision: 'block', reason: webCheck.reason || 'Unauthorized web call blocked.', severity: 'critical' };
        }

        for (const rule of RISKY_COMMAND_PATTERNS) {
            if (rule.regex.test(cmd)) {
                if (level === 'relaxed') {
                    return { decision: 'allow', reason: rule.reason, severity: 'high' };
                }
                return { decision: 'confirm', reason: rule.reason, severity: 'high' };
            }
        }

        if (level === 'strict') {
            return {
                decision: 'confirm',
                reason: 'Strict Security Mode requires user confirmation before running shell commands.',
                severity: 'low'
            };
        }

        return { decision: 'allow', reason: 'Command passed deterministic safety rules.', severity: 'low' };
    }

    public static analyzeScriptContent(content: string, scriptPath: string, level: AgentSecurityLevel, workspaceRoots?: string[]): { decision: 'allow' | 'confirm' | 'block'; reason: string; matchedLines: string[] } {
        if (!content) {
            return { decision: 'allow', reason: 'Empty script.', matchedLines: [] };
        }

        const lines = content.split(/\r?\n/);
        const blockedLines: string[] = [];
        const blockReasons = new Set<string>();

        const boundaryCheck = AgentSecurityGuard.checkWorkspaceBoundaryInText(content, workspaceRoots);
        if (!boundaryCheck.valid) {
            blockReasons.add(boundaryCheck.reason || 'Workspace boundary violation.');
        }

        const webCheck = AgentSecurityGuard.checkUnauthorizedWebCalls(content, true);
        if (!webCheck.allowed) {
            blockReasons.add(webCheck.reason || 'Unauthorized web call blocked.');
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const rule of SCRIPT_HARD_BLOCK_PATTERNS) {
                if (rule.regex.test(line)) {
                    blockedLines.push(`L${i + 1}: ${line.trim()}`);
                    blockReasons.add(rule.reason);
                }
            }
        }

        if (blockReasons.size > 0) {
            return {
                decision: 'block',
                reason: `Security policy blocked '${scriptPath}': ${Array.from(blockReasons).join('; ')}`,
                matchedLines: blockedLines
            };
        }

        const matchedLines: string[] = [];
        const reasons = new Set<string>();

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const rule of SCRIPT_DESTRUCTIVE_PATTERNS) {
                if (rule.regex.test(line)) {
                    matchedLines.push(`L${i + 1}: ${line.trim()}`);
                    reasons.add(rule.reason);
                }
            }
        }

        if (matchedLines.length > 0) {
            const summary = Array.from(reasons).join('; ');
            if (level === 'relaxed') {
                return { decision: 'allow', reason: summary, matchedLines };
            }
            return {
                decision: 'confirm',
                reason: `Script '${scriptPath}' contains potentially sensitive operations: ${summary}`,
                matchedLines
            };
        }

        if (level === 'strict') {
            return {
                decision: 'confirm',
                reason: `Strict Security Mode requires confirmation before executing '${scriptPath}'.`,
                matchedLines: []
            };
        }

        return { decision: 'allow', reason: 'Script passed static safety scan.', matchedLines: [] };
    }

    public static validateExecution(
        codeOrCommand: string,
        lang: string,
        options: { workspaceRoots?: string[]; level?: AgentSecurityLevel; scriptPath?: string } = {}
    ): { allowed: boolean; decision: 'allow' | 'confirm' | 'block'; reason: string; matchedLines?: string[] } {
        const level = options.level || 'guarded';
        const roots = options.workspaceRoots || (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
        if (roots.length === 0) {
            return { allowed: false, decision: 'block', reason: 'No active workspace folder; execution is forbidden outside a workspace.' };
        }

        const normLang = (lang || 'bash').toLowerCase().trim();
        const isShellLang = ['bash', 'sh', 'shell', 'zsh', 'fish', 'powershell', 'pwsh', 'cmd', 'bat', 'batch'].includes(normLang);

        if (isShellLang) {
            const shellRes = AgentSecurityGuard.analyzeShellCommand(codeOrCommand, level, roots);
            if (shellRes.decision === 'block') {
                return { allowed: false, decision: 'block', reason: shellRes.reason };
            }
            const scriptRes = AgentSecurityGuard.analyzeScriptContent(codeOrCommand, options.scriptPath || `<execute_code:${normLang}>`, level, roots);
            if (scriptRes.decision === 'block') {
                return { allowed: false, decision: 'block', reason: scriptRes.reason, matchedLines: scriptRes.matchedLines };
            }
            const finalDecision = shellRes.decision === 'confirm' || scriptRes.decision === 'confirm' ? 'confirm' : 'allow';
            return {
                allowed: finalDecision === 'allow',
                decision: finalDecision,
                reason: finalDecision === 'confirm' ? (shellRes.decision === 'confirm' ? shellRes.reason : scriptRes.reason) : 'Passed execution guard.',
                matchedLines: scriptRes.matchedLines
            };
        }

        const scriptRes = AgentSecurityGuard.analyzeScriptContent(codeOrCommand, options.scriptPath || `<execute_code:${normLang}>`, level, roots);
        return {
            allowed: scriptRes.decision === 'allow',
            decision: scriptRes.decision,
            reason: scriptRes.reason,
            matchedLines: scriptRes.matchedLines
        };
    }

    public static validateWriteContent(
        filePath: string,
        originalContent: string | null,
        newContent: string,
        level: AgentSecurityLevel,
        isFullFileWrite: boolean
    ): ContentValidationResult {
        if (!newContent || newContent.trim().length === 0) {
            if (originalContent && originalContent.trim().length > 0) {
                return {
                    valid: false,
                    requiresConfirmation: false,
                    reason: `Refusing to overwrite non-empty file '${filePath}' with empty content.`
                };
            }
        }

        if (newContent.includes('<<<<<<< SEARCH') || newContent.includes('>>>>>>> REPLACE')) {
            return {
                valid: false,
                requiresConfirmation: false,
                reason: `Integrity error: Unresolved Aider markers detected in final content for '${filePath}'.`
            };
        }

        if (isFullFileWrite) {
            const hasPlaceholder = newContent.split('\n').some(line => {
                const t = line.trim();
                return /^(?:\.{3,}|#\s*\.{3,}|(?:\/\/|--|;)\s*\.{3,})$/.test(t) ||
                    /(?:#|\/\/)\s*\.{3,}\s*(?:existing|rest|same|unchanged|omitted)/i.test(t);
            });
            if (hasPlaceholder) {
                return {
                    valid: false,
                    requiresConfirmation: level !== 'strict',
                    reason: `Detected placeholder ellipsis comments in full-file write for '${filePath}' which could erase existing code.`
                };
            }
        }

        if (originalContent !== null && originalContent.length > 400) {
            const ratio = newContent.length / originalContent.length;
            const origLines = originalContent.split('\n').length;
            const newLines = newContent.split('\n').length;
            const shrinkThreshold = level === 'strict' ? 0.65 : (level === 'guarded' ? 0.5 : 0.25);

            if (ratio < shrinkThreshold && (origLines - newLines) > 15) {
                return {
                    valid: false,
                    requiresConfirmation: true,
                    reason: `Massive code shrink detected in '${filePath}': ${origLines} lines (${originalContent.length} chars) -> ${newLines} lines (${newContent.length} chars, ${Math.round(ratio * 100)}% of original).`
                };
            }
        }

        return { valid: true, requiresConfirmation: false };
    }

    public async snapshotFile(
        workspaceRoot: vscode.WorkspaceFolder,
        fileUri: vscode.Uri,
        relPath: string,
        tool: string,
        action: AgentMutationRecord['action'],
        destinationUri?: vscode.Uri,
        destinationPath?: string
    ): Promise<AgentMutationRecord | null> {
        try {
            let existedBefore = false;
            let originalBytes: Uint8Array | null = null;

            try {
                const stat = await vscode.workspace.fs.stat(fileUri);
                if (stat.type === vscode.FileType.File) {
                    existedBefore = true;
                    originalBytes = await vscode.workspace.fs.readFile(fileUri);
                }
            } catch {
                existedBefore = false;
            }

            let backupPath: string | undefined;
            if (existedBefore && originalBytes) {
                const snapDir = vscode.Uri.joinPath(workspaceRoot.uri, '.lollms', 'snapshots', 'agent_guard');
                await vscode.workspace.fs.createDirectory(snapDir);
                const hash = crypto.createHash('md5').update(`${relPath}_${Date.now()}_${Math.random()}`).digest('hex').substring(0, 10);
                const snapFileName = `${hash}_${path.basename(relPath)}.bak`;
                const snapUri = vscode.Uri.joinPath(snapDir, snapFileName);
                await vscode.workspace.fs.writeFile(snapUri, originalBytes);
                backupPath = snapUri.fsPath;
            }

            const record: AgentMutationRecord = {
                id: `mut_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                timestamp: Date.now(),
                tool,
                filePath: relPath,
                uriString: fileUri.toString(),
                action,
                backupPath,
                destinationUriString: destinationUri?.toString(),
                destinationPath,
                existedBefore,
                reverted: false
            };

            this.mutations.push(record);
            if (this.mutations.length > 300) {
                this.mutations.shift();
            }
            this.markFileMutated(relPath);
            return record;
        } catch (err: any) {
            Logger.warn(`[AgentSecurityGuard] Failed to snapshot ${relPath}: ${err.message}`);
            return null;
        }
    }

    public async collectFilesForDeletionSnapshot(
        workspaceRoot: vscode.WorkspaceFolder,
        targetUri: vscode.Uri,
        relPath: string,
        tool: string
    ): Promise<{ isDirectory: boolean; filesSnapshotted: number }> {
        let isDirectory = false;
        let filesSnapshotted = 0;

        try {
            const stat = await vscode.workspace.fs.stat(targetUri);
            if (stat.type === vscode.FileType.Directory) {
                isDirectory = true;
                const walk = async (dirUri: vscode.Uri, curRel: string) => {
                    if (filesSnapshotted >= 200) return;
                    const entries = await vscode.workspace.fs.readDirectory(dirUri);
                    for (const [name, fType] of entries) {
                        if (filesSnapshotted >= 200) break;
                        if (name === '.git' || name === 'node_modules' || name === '.venv' || name === 'venv') continue;
                        const childUri = vscode.Uri.joinPath(dirUri, name);
                        const childRel = curRel ? `${curRel}/${name}` : name;
                        if (fType === vscode.FileType.Directory) {
                            await walk(childUri, childRel);
                        } else if (fType === vscode.FileType.File) {
                            await this.snapshotFile(workspaceRoot, childUri, childRel, tool, 'delete');
                            filesSnapshotted++;
                        }
                    }
                };
                await walk(targetUri, relPath);
            } else {
                await this.snapshotFile(workspaceRoot, targetUri, relPath, tool, 'delete');
                filesSnapshotted = 1;
            }
        } catch {}

        return { isDirectory, filesSnapshotted };
    }

    public async rollbackMutations(scope: 'last' | 'all', contextManager?: any): Promise<{ restored: string[]; deleted: string[]; errors: string[] }> {
        const restored: string[] = [];
        const deleted: string[] = [];
        const errors: string[] = [];

        const active = this.mutations.filter(m => !m.reverted);
        if (active.length === 0) {
            return { restored, deleted, errors };
        }

        const targets = scope === 'last' ? [active[active.length - 1]] : [...active].reverse();

        for (const rec of targets) {
            try {
                const targetUri = vscode.Uri.parse(rec.uriString);

                if (rec.action === 'move' && rec.destinationUriString) {
                    const destUri = vscode.Uri.parse(rec.destinationUriString);
                    try {
                        await vscode.workspace.fs.stat(destUri);
                        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(targetUri, '..'));
                        await vscode.workspace.fs.rename(destUri, targetUri, { overwrite: true });
                        restored.push(`${rec.destinationPath || ''} -> ${rec.filePath}`);
                    } catch {
                        if (rec.backupPath) {
                            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(rec.backupPath));
                            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(targetUri, '..'));
                            await vscode.workspace.fs.writeFile(targetUri, bytes);
                            restored.push(rec.filePath);
                        }
                    }
                } else if (!rec.existedBefore && rec.action === 'create') {
                    try {
                        await vscode.workspace.fs.delete(targetUri, { useTrash: true });
                        deleted.push(rec.filePath);
                    } catch {}
                } else if (rec.existedBefore && rec.backupPath) {
                    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(rec.backupPath));
                    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(targetUri, '..'));
                    await vscode.workspace.fs.writeFile(targetUri, bytes);
                    restored.push(rec.filePath);
                }

                rec.reverted = true;
                contextManager?.refreshFileInCache?.(targetUri);
            } catch (err: any) {
                errors.push(`${rec.filePath}: ${err.message}`);
            }
        }

        return { restored, deleted, errors };
    }
}