await (async () => {
  // Scroll the Architecture diagram into view and let the plugin's OWN reading-view
  // container observer auto-augment it. No manual augment call and no hardcoded
  // source — this exercises exactly what a user sees (docs/issues/mermaid-augment-lifecycle.md).
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // scroll the Architecture heading into view so its mermaid block lazy-renders
  const h = [...document.querySelectorAll('.markdown-reading-view h2')].find((e) => /Architecture/.test(e.textContent));
  h?.scrollIntoView({ block: 'start' });
  // poll for the rendered host AND the observer's badges (its debounce is 120ms)
  let host = null;
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    host = [...document.querySelectorAll('.mermaid')].find((m) => m.querySelector('g.node[id*="-CS-"]'));
    if (host && host.querySelectorAll('.review-md-node-badge').length) break;
  }
  if (!host) return 'no-host-after-poll';
  host.scrollIntoView({ block: 'center' });
  await sleep(300);
  return 'badges=' + host.querySelectorAll('.review-md-node-badge').length + ' commented=' + host.querySelectorAll('.review-md-commented').length;
})()
