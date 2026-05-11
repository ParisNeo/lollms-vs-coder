import { TagPlugin } from '../pluginSystem';

export const planStatusPlugin: TagPlugin = {
    id: 'plan_status',
    tagPattern: /<plan_status\s+([^>]*?)\s*\/>/gi,
    render: (match) => {
        const attrs: any = {};
        match[1].replace(/(\w+)=["']([^"']*)["']/g, (_: any, k: string, v: string) => (attrs[k] = v, ''));

        let tasks = [];
        try { tasks = JSON.parse(attrs.tasks || '[]'); } catch(e) {}

        const checklist = tasks.map((t: any) => {
            const isDone = t.status === 'completed';
            return `<div class="checklist-item ${isDone ? 'done' : ''}">
                <i class="codicon codicon-${isDone ? 'pass-filled' : 'circle-outline'}"></i>
                <span>${t.desc}</span>
            </div>`;
        }).join('');

        return `
        <div class="plan-status-card">
            <div class="plan-status-header">
                <span><i class="codicon codicon-checklist"></i> MISSION: ${attrs.completed}/${attrs.total}</span>
                <span>${attrs.percent}%</span>
            </div>
            <div class="plan-status-body">
                <div class="plan-progress-bar-container"><div class="plan-progress-bar-fill" style="width: ${attrs.percent}%"></div></div>
                <div class="plan-mini-checklist">${checklist}</div>
            </div>
        </div>`;
    }
};