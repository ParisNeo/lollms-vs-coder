import { Plan } from '../tools/tool';

export function generateMissionReport(plan: Plan, history: string[]): string {
    const title = `Lollms Mission Report: ${plan.objective.substring(0, 50)}...`;
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${title}</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 900px; margin: 0 auto; padding: 40px; background: #f5f5f5; }
        .report-card { background: white; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); overflow: hidden; }
        header { background: #007acc; color: white; padding: 30px; }
        h1 { margin: 0; font-size: 24px; }
        .objective { background: #e1f5fe; padding: 20px; border-left: 5px solid #03a9f4; margin: 20px; border-radius: 4px; }
        .section { padding: 0 20px 20px 20px; }
        .timeline-item { border: 1px solid #ddd; border-radius: 8px; margin-bottom: 15px; overflow: hidden; }
        .item-header { background: #f8f8f8; padding: 10px 15px; cursor: pointer; display: flex; justify-content: space-between; font-weight: bold; border-bottom: 1px solid #eee; }
        .item-header:hover { background: #f0f0f0; }
        .item-body { padding: 0; display: none; background: #fafafa; }
        .item-content { padding: 15px; white-space: pre-wrap; font-family: "Cascadia Code", "Consolas", monospace; font-size: 12px; line-height: 1.4; }
        .tag { font-size: 10px; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; background: #eee; }
    </style>
</head>
<body>
    <div class="report-card">
        <header>
            <h1>🚀 Lollms Mission Report</h1>
            <p>Generated on ${new Date().toLocaleString()}</p>
        </header>
        
        <div class="objective">
            <strong>OBJECTIVE:</strong><br>${plan.objective}
        </div>

        <div class="section">
            <h2>📜 Completed Actions Timeline</h2>
            ${history.map((step, i) => {
                const title = step.split('\n')[0] || `Step ${i+1}`;
                return `
                <div class="timeline-item">
                    <div class="item-header" onclick="toggle(this)">
                        <span>${title}</span>
                        <span class="tag">View Logs</span>
                    </div>
                    <div class="item-body">
                        <div class="item-content">${step.replace(/- PARAMETERS: (.*)/, '- PARAMETERS: <div style="background:#eee; padding:8px; border-radius:4px; margin:5px 0;">$1</div>')}</div>
                    </div>
                </div>`;
            }).join('')}
        </div>

        <div class="section">
            <h2>🧠 Final Brain State (Scratchpad)</h2>
            <div style="background: #fff8e1; padding: 15px; border-radius: 8px; border: 1px solid #ffe082;">
                ${plan.scratchpad.replace(/\n/g, '<br>')}
            </div>
        </div>
    </div>

    <script>
        function toggle(header) {
            const body = header.nextElementSibling;
            body.style.display = body.style.display === 'block' ? 'none' : 'block';
        }
    </script>
</body>
</html>`;
}