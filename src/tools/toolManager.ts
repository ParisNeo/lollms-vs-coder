import { ToolDefinition } from "./tool";
import { allTools } from './builtins';

export class ToolManager {
    private tools: Map<string, ToolDefinition> = new Map();
    private enabledTools: Set<string> = new Set();

    constructor() {
        this.loadTools();
        this.setDefaultEnabledTools();
    }

    private loadTools() {
        allTools.forEach(tool => {
            this.tools.set(tool.name, tool);
        });
    }

    private setDefaultEnabledTools() {
        this.enabledTools.clear();
        for (const tool of this.tools.values()) {
            if (tool.isDefault) {
                this.enabledTools.add(tool.name);
            }
        }
    }

    getTool(name: string): ToolDefinition | undefined {
        if (this.enabledTools.has(name)) {
            return this.tools.get(name);
        }
        return undefined;
    }

    getAllTools(): ToolDefinition[] {
        return Array.from(this.tools.values());
    }

    getEnabledTools(): ToolDefinition[] {
        return Array.from(this.enabledTools).map(name => this.tools.get(name)).filter((t): t is ToolDefinition => !!t);
    }
    
    setEnabledTools(toolNames: string[]) {
        this.enabledTools = new Set(toolNames);
    }
}
