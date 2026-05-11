import { TagPlugin } from '../pluginSystem';

export const milestonePlugin: TagPlugin = {
    id: 'milestone',
    tagPattern: /<milestone\s+([^>]*?)\s*\/>/gi,
    render: (match) => {
        const attrs: any = {};
        match[1].replace(/(\w+)=["']([^"']*)["']/g, (_: any, k: string, v: string) => (attrs[k] = v, ''));

        return `
        <div class="milestone-card">
            <div class="milestone-card-header"><span class="codicon codicon-bookmark"></span> <h3>Milestone: ${attrs.title || 'Mission Update'}</h3></div>
            <div class="milestone-body">
                <div class="milestone-section win"><div class="milestone-section-title">Achievements</div><div class="milestone-section-content">${attrs.achievements || ''}</div></div>
                <div class="milestone-section hurdle"><div class="milestone-section-title">Challenges</div><div class="milestone-section-content">${attrs.challenges || ''}</div></div>
                <div class="milestone-section fix"><div class="milestone-section-title">Solutions</div><div class="milestone-section-content">${attrs.solutions || ''}</div></div>
            </div>
        </div>`;
    }
};