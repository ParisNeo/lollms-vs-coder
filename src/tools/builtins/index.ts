import * as vscode from 'vscode';
import { ToolDefinition } from '../tool';
import { addFilesToContextTool } from './addFilesToContext';
import { autoSelectContextFilesTool } from './autoSelectContextFiles';
import { createPythonEnvironmentTool } from './createPythonEnvironment';
import { removeFilesFromContextTool } from './removeFilesFromContext';
import { editPlanTool } from './editPlan';
import { executeCommandTool } from './executeCommand';
import { executePythonScriptTool } from './executePythonScript';
import { generateCodeTool } from './generateCode';
import { generateImageTool } from './generateImage';
import { getEnvironmentDetailsTool } from './getEnvironmentDetails';
import { installPythonDependenciesTool } from './installPythonDependencies';
import { listFilesTool } from './listFiles';
import { deleteFileTool } from './deleteFile';
import { readCodeGraphTool } from './readCodeGraph';
import { updateCodeGraphTool } from './updateCodeGraph';
import { queryArchitectureTool } from './queryArchitecture';
import { readFileTool } from './readFile';
import { readFilesTool } from './readFiles';
import { requestUserInputTool } from './requestUserInput';
import { rlmReplTool } from './rlmRepl';
import { runFileTool } from './runFile';
import { scrapeWebsiteTool } from './scrapeWebsite';
import { searchArxivTool } from './searchArxiv';
import { grepSearchTool } from './searchFiles';
import { findFilesByNameTool } from './findFilesByName';
import { searchWebTool } from './searchWeb';
import { setLaunchEntrypointTool } from './setLaunchEntrypoint';
import { setVscodePythonInterpreterTool } from './setVscodePythonInterpreter';
import { submitResponseTool } from './submitResponse';
import { buildSkillTool } from './buildSkill';
import { prepareEnvironmentTool } from './prepareEnvironment';
import { researchWebPageTool } from './researchWebPage';
import { moltbookActionTool } from './moltbookAction';
import { waitTool } from './wait';
import { analyzeImageTool } from './analyzeImage';
import { projectMemoryTool } from './projectMemory';
import { createSvgAssetTool } from './createSvgAsset';
import { processImageAssetTool } from './processImageAsset';
import { runVerificationTool } from './runVerification';
import { moveFileTool } from './moveFile';
import { storeKnowledgeTool } from './storeKnowledge';
import { readMemoryCategoryTool } from './readMemoryCategory';
import { promoteMemoryToSkillTool } from './promoteMemoryToSkill';
import { extractYoutubeTranscriptTool } from './extractYoutubeTranscript';
import { summarizeTextTool } from './summarizeText';
import { reportPlanStatusTool } from './reportPlanStatus';
import { searchWikipediaTool } from './searchWikipedia';
import { searchStackOverflowTool } from './searchStackOverflow';
import { testWebPageTool } from './testWebPage';
import { captureDesktopTool } from './captureDesktop';
import { editCodeTool } from './editCode';
import { createAgentTool } from './createAgent';
import { delegateTaskTool } from './delegateTask';
import { requestSecureCredentialTool } from './requestSecureCredential';
import { uiHelpTool } from './uiHelp';
import { secureRunTool } from './secureRun';
import { webDiveTool } from './webDive';
import { webConsolidateTool } from './webConsolidate';
import { editImageAssetTool } from './editImageAsset';
import { buildGamePersonaTool } from './buildGamePersona';
import { buildGameAssetsTool } from './buildGameAssets';
import { requestFormInputTool } from './requestFormInput';
import { drawDebugAnnotationsTool } from './drawDebugAnnotations';
import { manageExtensionTool } from './manageExtension';
import { uiInteractionTool } from './uiInteraction';
import { manageToolsTool } from './manageTools';
import { manageSkillsTool } from './manageSkills';
import { extractImageTilesTool } from './extractImageTiles';
import { saveChatImageTool } from './saveChatImage';
import { checkPythonSyntaxTool } from './checkPythonSyntax';
import { testWebUiTool } from './testWebUi';
import { testDesktopPythonUiTool } from './testDesktopPythonUi';
import { testNativeUiTool } from './testNativeUi';


export const allTools: ToolDefinition[] = [
    testWebUiTool,
    testDesktopPythonUiTool,
    testNativeUiTool,
    checkPythonSyntaxTool,
    saveChatImageTool,
    extractImageTilesTool,
    uiHelpTool,
    secureRunTool,
    manageExtensionTool,
    webDiveTool,
    webConsolidateTool,
    editImageAssetTool,
    buildGamePersonaTool,
    buildGameAssetsTool,
    drawDebugAnnotationsTool,
    requestFormInputTool,
    manageToolsTool,
    manageSkillsTool,
    requestSecureCredentialTool,
    editCodeTool,
    createAgentTool,
    delegateTaskTool,
    testWebPageTool,
    captureDesktopTool,
    deleteFileTool,
    addFilesToContextTool,
    autoSelectContextFilesTool,
    createPythonEnvironmentTool,
    removeFilesFromContextTool,
    editPlanTool,
    executeCommandTool,
    executePythonScriptTool,
    generateCodeTool,
    generateImageTool,
    getEnvironmentDetailsTool,
    installPythonDependenciesTool,
    listFilesTool,
    readCodeGraphTool,
    queryArchitectureTool,
    updateCodeGraphTool,
    readFileTool,
    readFilesTool,
    requestUserInputTool,
    rlmReplTool,
    runFileTool,
    scrapeWebsiteTool,
    searchArxivTool,
    grepSearchTool,
    findFilesByNameTool,
    searchWebTool,
    setLaunchEntrypointTool,
    setVscodePythonInterpreterTool,
    buildSkillTool,
    submitResponseTool,
    prepareEnvironmentTool,
    researchWebPageTool,
    moltbookActionTool,
    waitTool,
    analyzeImageTool,
    projectMemoryTool,
    createSvgAssetTool,
    processImageAssetTool,
    runVerificationTool,
    moveFileTool,
    storeKnowledgeTool,
    readMemoryCategoryTool, // NEW
    promoteMemoryToSkillTool, 
    reportPlanStatusTool,
    {
        name: "search_deep_memory",
        description: "Retrieves the full content of a memory engram from deep storage using its ID found in the TIER 2 index.",
        isAgentic: true,
        isDefault: true,
        parameters: [
            { name: "id", type: "string", description: "The ID of the engram to retrieve.", required: true }
        ],
        async execute(params, env) {
            const manager = (env.agentManager as any)?.projectMemoryManager;
            if (!manager) return { success: false, output: "Memory Manager not available." };
            const engrams = await manager.getMemories();
            const match = engrams.find((e: any) => e.id === params.id);
            if (!match) return { success: false, output: `Engram ${params.id} not found.` };

            // Reinforce on read so it doesn't decay
            await manager.reinforceEngram(params.id);
            return { success: true, output: `[RECOVERED MEMORY: ${match.title}]\n${match.content}` };
        }
    },
    summarizeTextTool,
    searchWikipediaTool,
    searchStackOverflowTool,
    {
        name: "is_process_active",
        description: "Checks if a background process is still running. Useful for monitoring long-running tasks.",
        isAgentic: true,
        isDefault: true,
        parameters: [
            { name: "process_identifier", type: "string", description: "The name of the process (e.g., 'python.exe') or PID.", required: true }
        ],
        async execute(params, env, signal) {
            const isWin = process.platform === 'win32';
            const cmd = isWin 
                ? `Get-Process -Name "${params.process_identifier.replace('.exe', '')}" -ErrorAction SilentlyContinue` 
                : `pgrep -f "${params.process_identifier}"`;
            const result = await env.agentManager!.runCommand(cmd, signal);
            return { success: true, output: result.success ? "PROCESS_ACTIVE" : "PROCESS_NOT_FOUND" };
        }
    },
    {
        name: "read_output_tail",
        description: "Peeks at the last few lines of a log or output file. Use this to check progress of long-running tasks without consuming context.",
        isAgentic: true,
        isDefault: true,
        parameters: [
            { name: "path", type: "string", description: "Relative path to the file.", required: true },
            { name: "lines", type: "number", description: "Number of lines to read from the end. Default 50.", required: false }
        ],
        async execute(params, env) {
            if (!env.workspaceRoot) return { success: false, output: "No workspace." };
            const fullPath = vscode.Uri.joinPath(env.workspaceRoot.uri, params.path);
            try {
                const bytes = await vscode.workspace.fs.readFile(fullPath);
                const text = Buffer.from(bytes).toString('utf8');
                const linesArr = text.split('\n');
                const tail = linesArr.slice(-(params.lines || 50)).join('\n');
                return { success: true, output: `[LAST ${params.lines || 50} LINES OF ${params.path}]:\n\n${tail}` };
            } catch (e: any) { return { success: false, output: `Failed to peek: ${e.message}` }; }
        }
    },
    {
        name: "start_background_process",
        description: "Launches a long-running command (like model training or a server) in the background. It returns immediately with a handle. You MUST use 'read_output_tail' in future turns to monitor progress.",
        isAgentic: true,
        isDefault: true,
        permissionGroup: 'shell_execution',
        parameters: [
            { name: "command", type: "string", description: "The command to run.", required: true },
            { name: "handle", type: "string", description: "A unique name to track this process (e.g., 'training_run_1').", required: true },
            { name: "log_file", type: "string", description: "Relative path to a file where output should be redirected (e.g., '.lollms/logs/train.log').", required: true }
        ],
        async execute(params, env, signal) {
            if (!env.workspaceRoot) return { success: false, output: "No workspace." };

            const isWin = process.platform === 'win32';
            const logPath = params.log_file;
            const logDir = path.dirname(path.join(env.workspaceRoot.uri.fsPath, logPath));

            const fs = require('fs/promises');
            await fs.mkdir(logDir, { recursive: true });

            // Launch command with redirection
            // We use 'start' on windows / '&' on unix to detach
            let cmd = "";
            if (isWin) {
                // Use Start-Process in PowerShell to get a truly detached window/process
                cmd = `Start-Process powershell.exe -ArgumentList "-NoProfile -Command ${params.command} > ${logPath} 2>&1" -WindowStyle Hidden`;
            } else {
                cmd = `nohup ${params.command} > "${logPath}" 2>&1 & echo $!`;
            }

            const result = await env.agentManager!.runCommand(cmd, signal);

            if (result.success) {
                env.agentManager!.sessionState.backgroundProcesses.set(params.handle, {
                    pid: parseInt(result.output.trim()) || 0,
                    logFile: logPath,
                    startTime: Date.now()
                });
                return { success: true, output: `Process '${params.handle}' started in background. Output redirected to '${logPath}'.\n\n**ADVICE**: Your next task should be to 'wait' for a few seconds and then use 'read_output_tail' on '${logPath}' to verify it started correctly.` };
            }
            return result;
        }
    },
    {
        name: "stop_process",
        description: "Forcefully kills a process by its name or PID. Use this if you see the training logs are bad (e.g. NaN loss) or the app is hung.",
        isAgentic: true,
        isDefault: true,
        parameters: [
            { name: "process_identifier", type: "string", description: "The name of the process (e.g., 'python.exe') or PID.", required: true }
        ],
        async execute(params, env, signal) {
            const isWin = process.platform === 'win32';
            const cmd = isWin ? `taskkill /F /IM "${params.process_identifier}"` : `pkill -f "${params.process_identifier}"`;
            return await env.agentManager!.runCommand(cmd, signal);
        }
    }
];
