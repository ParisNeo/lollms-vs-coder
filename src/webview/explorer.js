const vscode = acquireVsCodeApi();
const canvas = document.getElementById('canvas');
const viewSelect = document.getElementById('view');

mermaid.initialize({
    theme: 'dark',
    securityLevel: 'loose'
});

let state = null;

function request() {
    vscode.postMessage({ type: 'requestData' });
}

viewSelect.onchange = render;

window.addEventListener('message', e => {
    if (e.data.type === 'data') {
        state = e.data;
        render();
    }
});

function render() {
    if (!state) return;
    canvas.innerHTML = '';

    if (viewSelect.value === 'class') {
        const pre = document.createElement('pre');
        pre.className = 'mermaid';
        pre.textContent = state.classDiagram;
        canvas.appendChild(pre);
        mermaid.run();
    }

    if (viewSelect.value === 'call') {
        import('./elkRenderer.js').then(m =>
            m.renderELK(canvas, state.callGraph)
        );
    }
}

request();
