const vscode = acquireVsCodeApi();

// --- UTILS ---
function jsEscape(str) {
    if (!str) return '';
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

let currentView = 'HISTORY';
let gitData = null;

// Hide loader once first update arrives
window.addEventListener('message', e => {
    const msg = e.data;
    
    if(msg.command === 'update' || msg.command === 'error') {
        const loader = document.getElementById('global-loader');
        if (loader) loader.style.display = 'none';
    }

    if(msg.command === 'update') {
        gitData = msg.data;
        renderBranches(gitData.branches, gitData.currentBranch);
        renderWorkingTree(gitData.status);
        renderTags(gitData.tags);
        renderStashes(gitData.stashes);
        renderGraph(gitData.graph);
    } else if (msg.command === 'error') {
        const inner = document.getElementById('graph-inner');
        if (inner) {
            inner.innerHTML = `<div style="color: var(--vscode-errorForeground); padding: 20px;">${escapeHtml(msg.message)}</div>`;
        }
    } else if(msg.command === 'showDiff') {
        renderDiff(msg.path, msg.diff);
    } else if(msg.command === 'commitDetails') {
        renderCommitDetails(msg.hash, msg.files);
    } else if(msg.command === 'setMessage') {
        document.getElementById('commit-msg-input').value = msg.message;
    } else if(msg.command === 'requestFileHistory') {
        switchView('FILE_HISTORY');
        const header = document.querySelector('#file-history-header h3');
        if(header) header.textContent = msg.path;
        document.getElementById('file-history-list').innerHTML = '<div style="opacity:0.5; padding:20px; text-align:center;"><i class="codicon codicon-sync spinner"></i> Fetching file log...</div>';
        post('getFileHistory', { path: msg.path });
    } else if(msg.command === 'fileHistory') {
        renderFileHistory(msg.path, msg.history);
    }
});

function post(cmd, extra = {}) { vscode.postMessage({ command: cmd, ...extra }); }

// NAVIGATION LOGIC
document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => {
        const view = tab.dataset.view;
        switchView(view);
    };
});

function toggleSection(id) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('collapsed');
}

// Attach globally for inline handlers
window.toggleSection = toggleSection;
window.post = post;
window.commit = commit;
window.generateAI = generateAI;
window.selectBranch = selectBranch;
window.selectFile = selectFile;
window.selectCommit = selectCommit;

function switchView(view) {
    currentView = view;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
    document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
    
    if (view === 'DIFF') {
        document.getElementById('section-changes').classList.remove('collapsed');
    }

    const target = document.getElementById('view-' + view) || document.getElementById('view-DETAILS');
    if (target) target.style.display = 'block';
}

function commit() { 
    const m = document.getElementById('commit-msg-input').value; 
    if(m) { post('commit', {message: m}); document.getElementById('commit-msg-input').value = ''; } 
}

function generateAI() { post('generateMessage'); }

// RENDERERS
function renderTags(tags) {
    const list = document.getElementById('tags-list');
    if (!list) return;
    
    if (!tags || tags.length === 0) {
        list.innerHTML = '<div style="opacity:0.3; padding:8px 24px; font-size:11px;">No tags found</div>';
        return;
    }

    list.innerHTML = tags.map(tag => `
        <div class="nav-item" onclick="selectCommit('${tag.name}')">
            <i class="codicon codicon-tag"></i>
            <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(tag.message)}">${escapeHtml(tag.name)}</span>
            <span style="font-size:9px; opacity:0.5; margin-right:8px;">${tag.date}</span>
            <div class="item-actions">
                <button class="icon-btn" onclick="event.stopPropagation(); post('checkoutRef', {ref: '${jsEscape(tag.name)}'})" title="Checkout Tag">
                    <i class="codicon codicon-export"></i>
                </button>
                <button class="icon-btn" onclick="event.stopPropagation(); post('rebaseRef', {ref: '${jsEscape(tag.name)}'})" title="Rebase current onto Tag">
                    <i class="codicon codicon-git-pull-request-go-to-changes"></i>
                </button>
                <button class="icon-btn" style="color:var(--vscode-errorForeground)" onclick="event.stopPropagation(); post('deleteTag', {name: '${jsEscape(tag.name)}'})" title="Delete Tag">
                    <i class="codicon codicon-trash"></i>
                </button>
            </div>
        </div>
    `).join('');
}

function renderStashes(stashes) {
    const list = document.getElementById('stashes-list');
    if (!list) return;

    if (!stashes || stashes.length === 0) {
        list.innerHTML = '<div style="opacity:0.3; padding:8px 24px; font-size:11px;">No stashed changes</div>';
        return;
    }

    list.innerHTML = stashes.map((s, i) => {
        const parts = s.split(': ');
        const label = parts.length > 1 ? parts.slice(1).join(': ') : s;
        return `
        <div class="nav-item">
            <i class="codicon codicon-archive"></i>
            <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(s)}">${escapeHtml(label)}</span>
            <div class="item-actions">
                <button class="icon-btn" onclick="event.stopPropagation(); post('stashApply', {index: ${i}})" title="Apply Stash">
                    <i class="codicon codicon-cloud-download"></i>
                </button>
                <button class="icon-btn" style="color:var(--vscode-errorForeground)" onclick="event.stopPropagation(); post('dropStash', {index: ${i}})" title="Drop Stash">
                    <i class="codicon codicon-trash"></i>
                </button>
            </div>
        </div>`;
    }).join('');
}

function renderBranches(branches, current) {
    const list = document.getElementById('local-branches-list');
    if (!list) return;
    
    list.innerHTML = (branches || []).map(b => {
        const isCurrent = b === current;
        const escapedName = jsEscape(b);
        return `
        <div class="nav-item ${isCurrent ? 'active' : ''}" onclick="selectBranch('${escapedName}')">
            <i class="codicon ${isCurrent ? 'codicon-record' : 'codicon-git-branch'}"></i>
            <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(b)}">${escapeHtml(b)}</span>
            <div class="item-actions">
                <button class="icon-btn" onclick="event.stopPropagation(); post('switch', {branch: '${escapedName}'})" title="Checkout Branch">
                    <i class="codicon codicon-target"></i>
                </button>
                <button class="icon-btn" onclick="event.stopPropagation(); post('renameBranch', {branch: '${escapedName}'})" title="Rename Branch">
                    <i class="codicon codicon-edit"></i>
                </button>
                <button class="icon-btn" onclick="event.stopPropagation(); post('branchFromCommit', {ref: '${escapedName}'})" title="Branch from here">
                    <i class="codicon codicon-git-branch"></i>
                </button>
                <button class="icon-btn" onclick="event.stopPropagation(); post('createTag', {ref: '${escapedName}'})" title="Create Tag from here">
                    <i class="codicon codicon-tag"></i>
                </button>
                <button class="icon-btn" onclick="event.stopPropagation(); post('mergeRef', {ref: '${escapedName}'})" title="Merge into current">
                    <i class="codicon codicon-git-merge"></i>
                </button>
                <button class="icon-btn" onclick="event.stopPropagation(); post('rebaseRef', {ref: '${escapedName}'})" title="Rebase current onto this branch">
                    <i class="codicon codicon-git-pull-request-go-to-changes"></i>
                </button>
                ${!isCurrent ? `
                <button class="icon-btn" style="color:var(--vscode-errorForeground)" onclick="event.stopPropagation(); post('deleteBranch', {branch: '${escapedName}'})" title="Delete Branch">
                    <i class="codicon codicon-trash"></i>
                </button>
                ` : ''}
            </div>
        </div>
        `;
    }).join('');
    
    const curBranchName = document.getElementById('current-branch-name');
    if (curBranchName) curBranchName.textContent = current;
    
    const statusBranchLabel = document.getElementById('status-branch-label');
    if (statusBranchLabel) statusBranchLabel.textContent = current;
}

function renderWorkingTree(status) {
    const sidebarContainer = document.getElementById('changes-list');
    const summaryContainer = document.getElementById('staging-summary');
    
    let sidebarHtml = '';
    
    const addSection = (title, files, isStaged, symbol) => {
        if(files.length === 0) return;
        sidebarHtml += `<div style="font-size:10px; font-weight:bold; opacity:0.4; padding: 10px 12px 4px 12px;">${title.toUpperCase()}</div>`;
        files.forEach(f => {
            sidebarHtml += `
            <div class="nav-item" onclick="selectFile('${jsEscape(f)}', ${isStaged})">
                <div class="file-status-badge status-${symbol}">${symbol}</div>
                <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(f)}">${escapeHtml(f)}</span>
                <div class="item-actions" style="margin-right: -10px">
                    <button class="icon-btn" onclick="event.stopPropagation(); post('${isStaged ? 'unstage' : 'stage'}', {path:'${jsEscape(f)}'})">
                        <i class="codicon codicon-${isStaged ? 'remove' : 'add'}"></i>
                    </button>
                </div>
            </div>`;
        });
    };

    addSection('Staged', status.staged, true, 'S');
    addSection('Unstaged', status.unstaged, false, 'M');
    addSection('Untracked', status.untracked, false, 'U');
    
    if (sidebarContainer) {
        sidebarContainer.innerHTML = sidebarHtml || '<div style="opacity:0.3; padding:12px; font-size:11px;">Clean working tree</div>';
    }
    
    if (summaryContainer) {
        summaryContainer.innerHTML = `
            <div style="font-size: 14px; font-weight: bold;">${status.staged.length} Files Ready to Commit</div>
            <div style="opacity: 0.6; font-size: 12px;">${status.unstaged.length + status.untracked.length} remaining changes.</div>
        `;
    }

    const statusIndexLabel = document.getElementById('status-index-label');
    if (statusIndexLabel) {
        statusIndexLabel.textContent = `${status.staged.length} staged · ${status.unstaged.length} unstaged`;
    }
}

function selectFile(path, isStaged, commitHash) {
    switchView('DIFF');
    document.getElementById('diff-content-area').innerHTML = '<div style="opacity:0.5; padding:40px; text-align:center;"><i class="codicon codicon-sync spinner"></i> Loading diff...</div>';
    if (commitHash) {
        // View diff of a specific file in a specific commit
        post('getFileDiff', { path, isCommitDiff: true, commitHash });
    } else {
        // View staged/unstaged diff
        post('getFileDiff', { path, staged: isStaged });
    }
}

function selectBranch(branchName) {
    switchView('DIFF');
    document.getElementById('diff-content-area').innerHTML = '<div style="opacity:0.5; padding:40px; text-align:center;"><i class="codicon codicon-sync spinner"></i> Inspecting branch delta...</div>';
    post('getFileDiff', { path: branchName, isBranchComparison: true });
    
    const right = document.getElementById('metadata-panel');
    right.innerHTML = `
        <div style="margin-bottom:20px;">
            <div style="font-size:10px; opacity:0.6; text-transform:uppercase; font-weight:bold;">Branch Context</div>
            <h3 style="margin:5px 0; color:var(--vscode-textLink-foreground);">${escapeHtml(branchName)}</h3>
            <p style="font-size:11px; opacity:0.7;">Viewing differences against current active branch.</p>
            <button class="btn" style="width:100%; margin-top:10px;" onclick="post('switch', {branch: '${jsEscape(branchName)}'})">
                <i class="codicon codicon-target"></i> Checkout this Branch
            </button>
        </div>
    `;
}

function renderDiff(path, diff) {
    const container = document.getElementById('diff-content-area');
    if (!diff || !diff.trim()) {
        container.innerHTML = '<div style="opacity:0.5; padding:40px; text-align:center;">No differences (File may be new or binary).</div>';
        return;
    }
    
    const lines = diff.split('\n').map(line => {
        let color = 'inherit';
        let bg = 'transparent';
        let opacity = '1';
        if (line.startsWith('+')) { color = 'var(--vscode-charts-green)'; bg = 'rgba(0,255,0,0.05)'; }
        else if (line.startsWith('-')) { color = 'var(--vscode-charts-red)'; bg = 'rgba(255,0,0,0.05)'; }
        else if (line.startsWith('@@')) { color = 'var(--vscode-charts-blue)'; opacity = '0.7'; }
        
        return `<div style="color:${color}; background:${bg}; opacity:${opacity}; padding: 0 10px; border-bottom: 1px solid rgba(255,255,255,0.02)">${escapeHtml(line)}</div>`;
    }).join('');

    container.innerHTML = `<div style="padding: 10px 0; background: var(--vscode-editor-background);">${lines}</div>`;
}

function renderBadges(deco) {
    if (!deco || !deco.trim()) return '';
    const clean = deco.trim().replace(/^\(|\)$/g, '');
    const parts = clean.split(', ');
    
    return parts.map(p => {
        let type = 'branch';
        let label = p;

        if (p.startsWith('HEAD -> ')) {
            type = 'head';
            label = 'HEAD: ' + p.substring(8);
        } else if (p.startsWith('tag: ')) {
            type = 'tag';
            label = p.substring(5);
        } else if (p.includes('/')) {
            type = 'remote';
        }

        return `<span class="badge-pill badge-${type}">${escapeHtml(label)}</span>`;
    }).join('');
}

function renderGraph(graph) {
    const inner = document.getElementById('graph-inner');
    if (!graph) {
        inner.innerHTML = '<div style="opacity:0.5; padding:20px; text-align:center;">No commit history found.</div>';
        return;
    }
    const graphLines = graph.split('\n').filter(l => l.trim());
    if (!graphLines.length) {
        inner.innerHTML = '<div style="opacity:0.5; padding:20px; text-align:center;">No commit history found.</div>';
        return;
    }

    const colors = ['#e06c75', '#98c379', '#d19a66', '#61afef', '#c678dd', '#56b6c2', '#abb2bf'];
    const charW = 14; 
    const rowH = 28;
    let paths = '';
    let htmlRows = '';
    let maxCols = 0;

    const grid = graphLines.map(line => {
        const match = line.match(/^([ \*\|\/\s\\\_]+)/);
        return match ? match[1] : '';
    });

    graphLines.forEach((line, rowIndex) => {
        const match = line.match(/^([ \*\|\/\s\\\_]+)(.*)$/);
        if (!match) return;

        const graphPart = match[1];
        let textPart = match[2];
        maxCols = Math.max(maxCols, graphPart.length);

        const y = rowIndex * rowH;
        const cy = y + rowH / 2;

        for (let col = 0; col < graphPart.length; col++) {
            const char = graphPart[col];
            if (char === ' ') continue;

            const cx = col * charW + 10;
            let color = colors[col % colors.length];

            if (char === '*') {
                // The Node (Commit)
                paths += `<circle cx="${cx}" cy="${cy}" r="5" fill="${color}" stroke="var(--vscode-editor-background)" stroke-width="2" />`;
                
                // Vertical line connection (Up)
                if (rowIndex > 0) {
                    const prevLineChar = grid[rowIndex-1][col];
                    if (prevLineChar === '*' || prevLineChar === '|') {
                        paths += `<line x1="${cx}" y1="${y}" x2="${cx}" y2="${cy}" stroke="${color}" stroke-width="2" />`;
                    }
                }
                // Vertical line connection (Down)
                if (rowIndex < grid.length - 1) {
                    const nextLineChar = grid[rowIndex+1][col];
                    if (nextLineChar === '*' || nextLineChar === '|') {
                        paths += `<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${y + rowH}" stroke="${color}" stroke-width="2" />`;
                    }
                }
            } else if (char === '|') {
                // Passing Lane
                paths += `<line x1="${cx}" y1="${y}" x2="${cx}" y2="${y + rowH}" stroke="${color}" stroke-width="2" />`;
            } else if (char === '/') {
                // Fork/Merge Connection
                const startX = (col + 1) * charW + 10;
                const endX = (col - 1) * charW + 10;
                paths += `<line x1="${startX}" y1="${y}" x2="${endX}" y2="${y + rowH}" stroke="${colors[(col+1)%colors.length]}" stroke-width="2" />`;
            } else if (char === '\\') {
                const startX = (col - 1) * charW + 10;
                const endX = (col + 1) * charW + 10;
                paths += `<line x1="${startX}" y1="${y}" x2="${endX}" y2="${y + rowH}" stroke="${colors[(col-1)%colors.length]}" stroke-width="2" />`;
            }
        }

        if (textPart.trim()) {
            const parts = textPart.split('|');
            if (parts.length < 5) return;
            const [hash, date, author, deco, message] = parts;
            // Dynamically calculate gutter based on lane width
            const gutterWidth = (maxCols * charW) + 15;
            const badgesHtml = renderBadges(deco);
            const isHead = deco && deco.includes('HEAD ->');

            htmlRows += `
                <div class="graph-html-row ${isHead ? 'head-row' : ''}" style="top: ${y}px; padding-left: ${gutterWidth}px;" onclick="selectCommit('${hash}')">
                    <span style="opacity:0.6; font-family:monospace; font-size:11px; width:60px; flex-shrink:0;">${hash ? hash.substring(0, 7) : ''}</span>
                    <div class="graph-msg" title="${escapeHtml(message)}">
                        ${badgesHtml}
                        <span style="${isHead ? 'font-weight:bold;' : ''}">${escapeHtml(message)}</span>
                    </div>
                    <span style="font-size:10px; opacity:0.5; width:90px; text-align:right; flex-shrink:0; margin-left:8px;">${escapeHtml(date)}</span>
                    <div class="item-actions">
                        <button class="icon-btn" onclick="event.stopPropagation(); post('copyToClipboard', {text:'${hash}'})" title="Copy Full SHA">
                            <i class="codicon codicon-copy"></i>
                        </button>
                        <button class="icon-btn" onclick="event.stopPropagation(); post('checkoutRef',{ref:'${hash}'})" title="Checkout Commit">
                            <i class="codicon codicon-export"></i>
                        </button>
                        <button class="icon-btn" onclick="event.stopPropagation(); post('inspectCommit',{hash:'${hash}'})" title="AI Security Audit">
                            <i class="codicon codicon-shield"></i>
                        </button>
                    </div>
                </div>`;
        }
    });

    const svgHeight = graphLines.length * rowH;
    inner.innerHTML = `
        <div style="position: relative; height: ${svgHeight}px;">
            <svg width="${maxCols * charW + 20}" height="${svgHeight}" style="position: absolute; top: 0; left: 0; z-index: 1; pointer-events: none;">
                ${paths}
            </svg>
            <div style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 2;">
                ${htmlRows}
            </div>
        </div>`;
}

function selectCommit(hash) {
    document.querySelectorAll('.graph-html-row').forEach(r => r.classList.remove('selected'));
    const row = document.querySelector(`.graph-html-row[onclick*='${hash}']`);
    if (row) row.classList.add('selected');

    const right = document.getElementById('metadata-panel');
    right.innerHTML = `
        <div style="text-align:center; padding: 40px; opacity: 0.5;">
            <div class="spinner"></div>
            <p>Loading commit data...</p>
        </div>
    `;
    // Trigger extension to fetch files
    post('selectCommit', { hash });

    // Automatically update the Diff tab with the full commit patch
    document.getElementById('diff-content-area').innerHTML = '<div style="opacity:0.5; padding:40px; text-align:center;"><i class="codicon codicon-sync spinner"></i> Loading commit diff...</div>';
    post('getFileDiff', { path: hash, isCommitDiff: true });
}

function renderFileHistory(path, history) {
    const list = document.getElementById('file-history-list');
    if (!list) return;

    if (!history || history.length === 0) {
        list.innerHTML = '<div style="opacity:0.3; padding:20px; text-align:center;">No history found for this file path.</div>';
        return;
    }

    list.innerHTML = history.map(c => `
        <div class="list-row" onclick="selectFile('${jsEscape(path)}', false, '${c.hash}')" style="border-bottom: 1px solid var(--vscode-widget-border); padding: 10px; display:flex; align-items:center; gap:12px;">
            <span style="font-family:monospace; opacity:0.6; font-size:11px; width:60px;">${c.hash.substring(0, 7)}</span>
            <div style="flex:1; min-width:0;">
                <div style="font-weight:bold; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(c.message)}">${escapeHtml(c.message)}</div>
                <div style="font-size:10px; opacity:0.5;">${escapeHtml(c.author)} • ${c.date}</div>
            </div>
            <div class="item-actions" style="position:static; opacity:1;">
                <button class="icon-btn" onclick="event.stopPropagation(); post('inspectCommit',{hash:'${c.hash}'})" title="AI Security Audit">
                    <i class="codicon codicon-shield"></i>
                </button>
            </div>
        </div>
    `).join('');
}

function renderCommitDetails(hash, files) {
    const right = document.getElementById('metadata-panel');
    const fileItems = files.map(f => `
        <div class="nav-item" onclick="selectFile('${jsEscape(f)}', false, '${hash}')">
            <i class="codicon codicon-file-code"></i>
            <span style="flex:1; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(f)}</span>
            <div class="item-actions">
                 <button class="icon-btn" onclick="event.stopPropagation(); post('copyToClipboard', {text:'${jsEscape(f)}'})" title="Copy Path">
                    <i class="codicon codicon-copy"></i>
                </button>
            </div>
        </div>
    `).join('');

    right.innerHTML = `
        <div style="margin-bottom:20px;">
            <div style="font-size:10px; opacity:0.6; text-transform:uppercase; font-weight:bold;">Commit ID</div>
            <h3 style="margin:5px 0; color:var(--vscode-textLink-foreground);">${hash.substring(0, 8)}</h3>
            <button class="btn" style="width:100%; margin-top: 10px;" onclick="post('inspectCommit', {hash:'${hash}'})">
                <i class="codicon codicon-shield"></i> Security Audit (AI)
            </button>
        </div>

        <div class="nav-section" id="section-commit-files">
            <div class="nav-section-header" onclick="toggleSection('section-commit-files')">
                <span>CHANGED FILES (${files.length})</span>
                <i class="codicon codicon-chevron-down"></i>
            </div>
            <div class="nav-content" style="max-height: 400px; overflow-y: auto; background: rgba(0,0,0,0.1); border-radius: 4px;">
                ${fileItems}
            </div>
        </div>

        <div class="nav-section-header" style="margin-top:20px;">ACTIONS</div>
        <div style="display:flex; flex-direction:column; gap:6px; margin-top:10px;">
            <button class="btn btn-secondary" onclick="post('checkoutRef', {ref: '${hash}'})">
                <i class="codicon codicon-export"></i> Checkout this commit
            </button>
            <button class="btn btn-secondary" onclick="post('branchFromCommit', {ref: '${hash}'})">
                <i class="codicon codicon-git-branch"></i> Branch from here
            </button>
            <button class="btn btn-secondary" style="color:var(--vscode-errorForeground)" onclick="post('revertCommit', {hash:'${hash}'})">
                <i class="codicon codicon-history"></i> Revert Commit
            </button>
        </div>
    `;
}

function setupResizer(resizerId, targetId, isRight) {
    const resizer = document.getElementById(resizerId);
    const target = document.getElementById(targetId);
    if (!resizer || !target) return;
    let isDown = false;
    resizer.addEventListener('mousedown', (e) => {
        isDown = true;
        resizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
    });
    window.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        if (isRight) {
            const newWidth = document.body.clientWidth - e.clientX;
            if (newWidth > 200 && newWidth < 800) target.style.width = newWidth + 'px';
        } else {
            const newWidth = e.clientX;
            if (newWidth > 200 && newWidth < 800) target.style.width = newWidth + 'px';
        }
    });
    window.addEventListener('mouseup', () => {
        if (isDown) {
            isDown = false;
            resizer.classList.remove('dragging');
            document.body.style.cursor = 'default';
        }
    });
}

setupResizer('resizer-left', 'sidebar-left', false);
setupResizer('resizer-right', 'metadata-panel', true);

// Signal ready
post('ready');