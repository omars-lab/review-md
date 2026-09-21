await (async () => {
  const p = app.plugins.plugins["review-md"];
  const src = [
    'flowchart TB',
    '  URL["obsidian://review-md-open?vault=…&file=…&thread=…"] --> PH[Protocol handler]',
    '  PH --> RV[Reviewer view]',
    '  RV -->|click a rendered element| CS["Comment store · .name.comments.md sidecar"]',
    '  CS --> MA[Mermaid augmenter]',
    '  MA -->|augmented SVG| RV',
    '  RV --> SL[Share link · x-callback]',
    '  SL -.->|reply URL| PH',
  ].join('\n');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // scroll the Architecture heading into view so its mermaid block lazy-renders
  const h = [...document.querySelectorAll('.markdown-reading-view h2')].find((e) => /Architecture/.test(e.textContent));
  h?.scrollIntoView({ block: 'start' });
  // poll for the rendered architecture diagram host (has the CS node)
  let host = null;
  for (let i = 0; i < 30 && !host; i++) {
    await sleep(100);
    host = [...document.querySelectorAll('.mermaid')].find((m) => m.querySelector('g.node[id*="-CS-"]'));
  }
  if (!host) return 'no-host-after-poll';
  await p.augmentRenderedMermaid(host, src, 'designs/design.md');
  await sleep(300);
  return 'badges=' + host.querySelectorAll('.review-md-node-badge').length + ' commented=' + host.querySelectorAll('.review-md-commented').length;
})()
