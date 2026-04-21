import { ToolDefinition } from '../tool';
import { autoSelectContextFilesTool } from './autoSelectContextFiles';
import { createPythonEnvironmentTool } from './createPythonEnvironment';
import { deselectContextFilesTool } from './deselectContextFiles';
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
import { requestUserInputTool } from './requestUserInput';
import { rlmReplTool } from './rlmRepl';
import { runFileTool } from './runFile';
import { scrapeWebsiteTool } from './scrapeWebsite';
import { searchArxivTool } from './searchArxiv';
import { searchFilesTool } from './searchFiles';
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
import { createSvgAssetTool } from './createSvgAsset';
import { processImageAssetTool } from './processImageAsset';
import { runVerificationTool } from './runVerification';
import { moveFileTool } from './moveFile';
import { storeKnowledgeTool } from './storeKnowledge';
import { readMemoryCategoryTool } from './readMemoryCategory';
import { promoteMemoryToSkillTool } from './promoteMemoryToSkill';
import { extractYoutubeTranscriptTool } from './extractYoutubeTranscript';
import { summarizeTextTool } from './summarizeText';
import { searchWikipediaTool } from './searchWikipedia';
import { searchStackOverflowTool } from './searchStackOverflow';
import { testWebPageTool } from './testWebPage';
import { captureDesktopTool } from './captureDesktop';
import { editCodeTool } from './editCode';
import { createAgentTool } from './createAgent';
import { delegateTaskTool } from './delegateTask';
import { requestSecureCredentialTool } from './requestSecureCredential';

export const allTools: ToolDefinition[] = [
    requestSecureCredentialTool,
    editCodeTool,
    createAgentTool,
    createAgentTool,
    delegateTaskTool,
    testWebPageTool,
    captureDesktopTool,
    deleteFileTool,
    autoSelectContextFilesTool,
    createPythonEnvironmentTool,
    deselectContextFilesTool,
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
    requestUserInputTool,
    rlmReplTool,
    runFileTool,
    scrapeWebsiteTool,
    searchArxivTool,
    searchFilesTool,
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
    createSvgAssetTool,
    processImageAssetTool,
    runVerificationTool,
    moveFileTool,
    storeKnowledgeTool,
    readMemoryCategoryTool, // NEW
    promoteMemoryToSkillTool, // NEW
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
