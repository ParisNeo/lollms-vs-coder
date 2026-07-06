import * as vscode from 'vscode';
import { ToolDefinition } from '../tool';
import { addFilesToContextTool } from './addFilesToContext';
import { autoSelectContextFilesTool } from './autoSelectContextFiles';
import { manageSelectionsTool } from './manageSelections';
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
import { searchArxivTool } from './searchArxiv';
import { navigateToCodeTool } from './navigateToCode';
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
import { peekAtContextTool } from './peekAtContext';
import { readFileRelationsTool } from './readFileRelations';
import { searchWikipediaTool } from './searchWikipedia';
import { searchStackOverflowTool } from './searchStackOverflow';
import { testWebPageTool } from './testWebPage';
import { generateCodeTool } from './generateCode';
import { editCodeTool } from './editCode';
import { updateFunctionTool } from './updateFunction';

export const allTools: ToolDefinition[] = [
    searchWebTool,
    searchArxivTool,
    navigateToCodeTool,
    testWebPageTool,
    generateCodeTool,
    editCodeTool,
    updateFunctionTool
];

export const enabledToolsList = [
    'read_file',
    'read_files',
    'edit_code',
    'generate_code',
    'update_function',
    'execute_command',
    'submit_response',
    'read_code_graph'
];
