import { DiscussionCapabilities } from './dom';

export interface PluginContext {
    messageId: string;
    isFinal: boolean;
    capabilities: DiscussionCapabilities | null;
    vscode: any;
}

export interface TagPlugin {
    id: string;
    // For Discussion Mode
    tagPattern?: RegExp; 

    // For Agent Mode (The JSON "tool" name)
    toolName?: string;

    // Logic to render the HTML string from either an XML match or a raw JSON object
    render: (match: RegExpExecArray | any, context: PluginContext) => string | null;

    // Logic to attach event listeners after DOM injection
    initialize?: (container: HTMLElement, context: PluginContext) => void;

    // Fragment to inject into the LLM system prompt
    systemPromptFragment?: string;
}

export const pluginRegistry: TagPlugin[] = [];

export function registerPlugin(plugin: TagPlugin) {
    pluginRegistry.push(plugin);
}