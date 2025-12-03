import { ToolDefinition } from '../tool';
import { autoSelectContextFilesTool } from './autoSelectContextFiles';
import { createPythonEnvironmentTool } from './createPythonEnvironment';
import { deselectContextFilesTool } from './deselectContextFiles';
import { executeCommandTool } from './executeCommand';
import { executePythonScriptTool } from './executePythonScript';
import { generateCodeTool } from './generateCode';
import { getEnvironmentDetailsTool } from './getEnvironmentDetails';
import { installPythonDependenciesTool } from './installPythonDependencies';
import { listFilesTool } from './listFiles';
import { readFileTool } from './readFile';
import { requestUserInputTool } from './requestUserInput';
import { setLaunchEntrypointTool } from './setLaunchEntrypoint';
import { setVscodePythonInterpreterTool } from './setVscodePythonInterpreter';
import { searchWebTool } from './searchWeb';
import { generateImageTool } from './generateImage';
import { editPlanTool } from './editPlan';
import { readCodeGraphTool } from './readCodeGraph'; // Import new tool

export const allTools: ToolDefinition[] = [
    autoSelectContextFilesTool,
    createPythonEnvironmentTool,
    deselectContextFilesTool,
    executeCommandTool,
    executePythonScriptTool,
    generateCodeTool,
    getEnvironmentDetailsTool,
    installPythonDependenciesTool,
    listFilesTool,
    readFileTool,
    requestUserInputTool,
    setLaunchEntrypointTool,
    setVscodePythonInterpreterTool,
    searchWebTool,
    generateImageTool,
    editPlanTool,
    readCodeGraphTool // Register new tool
];
