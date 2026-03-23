const puppeteer = require('puppeteer-core');
(async () => {
  const res = await fetch('http://localhost:9000/json/version');
  const data = await res.json();
  const browser = await puppeteer.connect({ browserWSEndpoint: data.webSocketDebuggerUrl });
  const pages = await browser.pages();
  const page = pages.find(p => p.url().includes('localhost') || p.url().includes('vscode'));
  if (!page) { console.log('No page'); process.exit(1); }
  
  const result = await page.evaluate(() => {
    const sashes = Array.from(document.querySelectorAll('.monaco-sash'));
    return sashes.map(s => ({
      className: s.className,
      cursor: window.getComputedStyle(s).cursor
    }));
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
})();
