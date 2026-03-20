const puppeteer = require('puppeteer-core');

(async () => {
  const resp = await fetch('http://localhost:9222/json/version');
  const data = await resp.json();
  const browser = await puppeteer.connect({ browserWSEndpoint: data.webSocketDebuggerUrl, defaultViewport: null });
  const pages = await browser.pages();
  
  // Check each page for chat messages
  for (let i = 0; i < pages.length; i++) {
    const title = await pages[i].title().catch(() => 'N/A');
    
    // Scan for common message-like elements
    const scan = await pages[i].evaluate(`(function() {
      var results = [];
      
      // Look for elements that might be messages
      var all = document.querySelectorAll('div, p, span, section, article');
      for (var j = 0; j < all.length; j++) {
        var el = all[j];
        var cn = (el.className || '').toString();
        var text = (el.textContent || '').trim().substring(0, 60);
        
        // Look for message-related class names
        if (cn.indexOf('message') !== -1 || 
            cn.indexOf('chat') !== -1 || 
            cn.indexOf('response') !== -1 ||
            cn.indexOf('conversation') !== -1 ||
            cn.indexOf('turn') !== -1 ||
            cn.indexOf('assistant') !== -1) {
          if (text.length > 10 && text.length < 200) {
            results.push({
              tag: el.tagName,
              className: cn.substring(0, 100),
              textPreview: text
            });
          }
        }
      }
      return results.slice(0, 15);
    })()`).catch(() => []);
    
    console.log('Page ' + i + ': ' + title + ' (' + scan.length + ' message-like elements)');
    if (scan.length > 0) {
      scan.forEach(s => console.log('  ', JSON.stringify(s)));
    }
    console.log();
  }
  
  browser.disconnect();
})();
