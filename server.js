const express = require('express');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const path = require('path');
const zlib = require('zlib');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Proxy endpoint
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // Only allow http/https
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: 'Only HTTP/HTTPS URLs are supported' });
  }

  const client = parsedUrl.protocol === 'https:' ? https : http;

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate',
    },
    timeout: 15000,
  };

  try {
    const proxyReq = client.request(options, (proxyRes) => {
      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
        let redirectUrl = proxyRes.headers.location;
        try {
          redirectUrl = new URL(redirectUrl, targetUrl).href;
        } catch {}
        return res.redirect('/proxy?url=' + encodeURIComponent(redirectUrl));
      }

      const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
      const isHtml = contentType.includes('text/html');
      const encoding = proxyRes.headers['content-encoding'];

      if (!isHtml) {
        // For non-HTML (images, CSS, JS, etc.), pipe through directly
        res.set('Content-Type', proxyRes.headers['content-type'] || 'application/octet-stream');
        if (proxyRes.headers['cache-control']) {
          res.set('Cache-Control', proxyRes.headers['cache-control']);
        }

        let stream = proxyRes;
        if (encoding === 'gzip') {
          stream = proxyRes.pipe(zlib.createGunzip());
        } else if (encoding === 'deflate') {
          stream = proxyRes.pipe(zlib.createInflate());
        } else if (encoding === 'br') {
          stream = proxyRes.pipe(zlib.createBrotliDecompress());
        }

        stream.pipe(res);
        stream.on('error', () => res.status(502).end());
        return;
      }

      // For HTML, collect the body and rewrite URLs
      let stream = proxyRes;
      if (encoding === 'gzip') {
        stream = proxyRes.pipe(zlib.createGunzip());
      } else if (encoding === 'deflate') {
        stream = proxyRes.pipe(zlib.createInflate());
      } else if (encoding === 'br') {
        stream = proxyRes.pipe(zlib.createBrotliDecompress());
      }

      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', () => res.status(502).send('Decompression error'));
      stream.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf-8');
        body = rewriteHtml(body, targetUrl);

        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(body);
      });
    });

    proxyReq.on('error', (err) => {
      res.status(502).json({ error: 'Failed to reach the site: ' + err.message });
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      res.status(504).json({ error: 'Request timed out' });
    });

    proxyReq.end();
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

function rewriteHtml(html, baseUrl) {
  const base = new URL(baseUrl);
  const origin = base.origin;

  // Remove any existing <base> tag
  html = html.replace(/<base\s[^>]*>/gi, '');

  // Inject our base tag right after <head>
  html = html.replace(/(<head[^>]*>)/i, '$1<base href="' + escapeHtml(baseUrl) + '">');

  // Rewrite absolute URLs in common attributes to go through proxy
  html = html.replace(
    /((?:href|src|action|poster|data)\s*=\s*["'])(https?:\/\/[^"']*)(["'])/gi,
    (match, prefix, url, suffix) => {
      if (url === baseUrl || url === origin) return match;
      return prefix + '/proxy?url=' + encodeURIComponent(url) + suffix;
    }
  );

  // Rewrite srcset URLs
  html = html.replace(
    /(srcset\s*=\s*["'])([^"']+)(["'])/gi,
    (match, prefix, value, suffix) => {
      const rewritten = value.replace(
        /(https?:\/\/[^\s,]+)/g,
        (url) => '/proxy?url=' + encodeURIComponent(url)
      );
      return prefix + rewritten + suffix;
    }
  );

  // Rewrite CSS url() references with absolute URLs
  html = html.replace(
    /url\(\s*["']?(https?:\/\/[^"')]+)["']?\s*\)/gi,
    (match, url) => 'url(/proxy?url=' + encodeURIComponent(url) + ')'
  );

  // Inject a script that intercepts navigation
  const interceptScript = `
<script>
(function() {
  document.addEventListener('click', function(e) {
    var link = e.target.closest('a[href]');
    if (!link) return;
    var href = link.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    e.preventDefault();
    var fullUrl = href;
    if (href.startsWith('/proxy?url=')) {
      fullUrl = decodeURIComponent(href.split('url=')[1]);
    } else if (!href.startsWith('http')) {
      try { fullUrl = new URL(href, document.baseURI).href; } catch(ex) { return; }
    }
    window.parent.postMessage({ type: 'proxy-navigate', url: fullUrl }, '*');
  }, true);
  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (form.method && form.method.toLowerCase() === 'post') return;
    e.preventDefault();
    var action = form.action || window.location.href;
    var params = new URLSearchParams(new FormData(form)).toString();
    var url = action + (action.includes('?') ? '&' : '?') + params;
    window.parent.postMessage({ type: 'proxy-navigate', url: url }, '*');
  }, true);
})();
</script>`;

  if (html.includes('</body>')) {
    html = html.replace('</body>', interceptScript + '</body>');
  } else {
    html += interceptScript;
  }

  return html;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

app.listen(PORT, () => {
  console.log('Proxy browser running on port ' + PORT);
});
