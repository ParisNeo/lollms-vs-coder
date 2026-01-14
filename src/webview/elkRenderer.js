export async function renderELK(container, graph) {
    const elk = new ELK();
    const layout = await elk.layout({
        id: 'root',
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            'elk.spacing.nodeNode': '40'
        },
        children: graph.nodes.map(n => ({
            id: n.id,
            width: 160,
            height: 40,
            labels: [{ text: n.label }]
        })),
        edges: graph.edges.map(e => ({
            id: e.id,
            sources: [e.source],
            targets: [e.target]
        }))
    });

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

    layout.children.forEach(n => {
        const g = document.createElementNS(svg.namespaceURI, 'g');
        g.setAttribute('transform', `translate(${n.x},${n.y})`);

        const r = document.createElementNS(svg.namespaceURI, 'rect');
        r.setAttribute('width', n.width);
        r.setAttribute('height', n.height);
        r.setAttribute('rx', 6);
        r.setAttribute('fill', '#252526');
        r.setAttribute('stroke', '#4fc3f7');

        const t = document.createElementNS(svg.namespaceURI, 'text');
        t.setAttribute('x', 8);
        t.setAttribute('y', 24);
        t.setAttribute('fill', '#ddd');
        t.textContent = n.labels[0].text;

        g.append(r, t);
        svg.appendChild(g);
    });

    layout.edges.forEach(e => {
        const p = document.createElementNS(svg.namespaceURI, 'path');
        const pts = e.sections[0].points;
        p.setAttribute(
            'd',
            `M${pts.map(p => `${p.x},${p.y}`).join(' L ')}`
        );
        p.setAttribute('stroke', '#888');
        p.setAttribute('fill', 'none');
        svg.appendChild(p);
    });

    container.appendChild(svg);
}
