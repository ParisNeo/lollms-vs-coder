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
import { readCodeGraphTool } from './readCodeGraph';
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
import { searchWebTool } from './searchWeb';
import { generateImageTool } from './generateImage';
import { editPlanTool } from './editPlan';
import { readCodeGraphTool } from './readCodeGraph';
import { searchArxivTool } from './searchArxiv';
import { scrapeWebsiteTool } from './scrapeWebsite';
import { searchFilesTool } from './searchFiles';
import { buildSkillTool } from './buildSkill';
import { runFileTool } from './runFile';
import { submitResponseTool } from './submitResponse';
import { buildSkillTool } from './buildSkill';
import { prepareEnvironmentTool } from './prepareEnvironment';
import { researchWebPageTool } from './researchWebPage';
import { moltbookActionTool } from './moltbookAction';
import { waitTool } from './wait';
import { analyzeImageTool } from './analyzeImage';
import { moveFileTool } from './moveFile';

export const allTools: ToolDefinition[] = [
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
    searchWebTool,
    generateImageTool,
    editPlanTool,
    readCodeGraphTool,
    searchArxivTool,
    scrapeWebsiteTool,
    searchFilesTool,
    buildSkillTool,
    runFileTool,
    submitResponseTool,
    buildSkillTool,
    prepareEnvironmentTool,
    researchWebPageTool,
    moltbookActionTool,
    waitTool,
    analyzeImageTool,
    moveFileTool
];
