// server.js - Pure Static Website Cloner (No JavaScript at all)
const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const crypto = require('crypto');
const cheerio = require('cheerio');

const app = express();
app.use(cors({
  origin: "*"
}));
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3001;
const CLONE_DIR = path.join(__dirname, 'clones');

if (!fs.existsSync(CLONE_DIR)) {
  fs.mkdirSync(CLONE_DIR, { recursive: true });
}

// Helper: Get safe filename from URL
function getSafeFilename(url, mimeType, resourceType) {
  try {
    const urlObj = new URL(url);
    let basename = path.basename(urlObj.pathname);
    
    if (!basename || !basename.includes('.')) {
      let ext = '';
      if (mimeType) {
        const parts = mimeType.split('/')[1]?.split(';')[0];
        if (parts === 'css') ext = 'css';
        else if (parts === 'svg+xml') ext = 'svg';
        else ext = parts || '';
      }
      if (!ext) {
        if (resourceType === 'stylesheet') ext = 'css';
        else if (resourceType === 'image') ext = 'jpg';
        else if (resourceType === 'font') ext = 'woff2';
        else ext = 'bin';
      }
      basename = `index.${ext}`;
    }
    
    basename = basename.split('?')[0].replace(/[^a-zA-Z0-9.\-_]/g, '_');
    return basename || `file.${ext}`;
  } catch (e) {
    return `unknown_${Date.now()}.bin`;
  }
}

// Helper: Aggressively remove all JavaScript and rewrite asset URLs
function sanitizeHtml(html, assetMap) {
  const $ = cheerio.load(html);
  
  // ─── 1. REMOVE ALL SCRIPT TAGS ─────────────────────────────
  // Remove external scripts
  $('script[src]').remove();
  // Remove inline scripts (including those with type="module")
  $('script').each((i, el) => {
    // If it survived the src removal, it's an inline script – remove it
    $(el).remove();
  });
  
  // Remove event handler attributes that contain JavaScript
  $('[onclick], [onload], [onerror], [onmouseover], [onmouseout], [onsubmit], [onchange], [oninput], [onkeydown], [onkeyup]').each((i, el) => {
    // Remove all "on*" attributes
    const attrs = Object.keys(el.attribs);
    attrs.forEach(attr => {
      if (attr.toLowerCase().startsWith('on')) {
        $(el).removeAttr(attr);
      }
    });
  });
  
  // Remove javascript: links (href="javascript:...")
  $('a[href^="javascript:"]').each((i, el) => {
    $(el).attr('href', '#');
  });
  
  // ─── 2. REWRITE ASSET URLS ─────────────────────────────────
  // CSS links
  $('link[rel="stylesheet"]').each((i, el) => {
    const href = $(el).attr('href');
    if (href && assetMap[href]) {
      $(el).attr('href', assetMap[href]);
    }
  });
  
  // Images
  $('img[src]').each((i, el) => {
    const src = $(el).attr('src');
    if (src && assetMap[src]) {
      $(el).attr('src', assetMap[src]);
    }
  });
  
  // srcset
  $('img[srcset]').each((i, el) => {
    const srcset = $(el).attr('srcset');
    if (srcset) {
      const parts = srcset.split(',').map(part => {
        const [url, size] = part.trim().split(/\s+/);
        if (assetMap[url]) {
          return `${assetMap[url]} ${size || ''}`.trim();
        }
        return part;
      });
      $(el).attr('srcset', parts.join(', '));
    }
  });

  // Background images in inline styles
  $('[style]').each((i, el) => {
    let style = $(el).attr('style');
    if (style) {
      style = style.replace(/url\(["']?([^"')]+)["']?\)/g, (match, url) => {
        if (assetMap[url]) {
          return `url("${assetMap[url]}")`;
        }
        return match;
      });
      $(el).attr('style', style);
    }
  });

  return $.html();
}

app.post('/clone', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const jobId = crypto.randomBytes(8).toString('hex');
  const jobDir = path.join(CLONE_DIR, jobId);
  const assetsDir = path.join(jobDir, 'assets');
  
  try {
    fs.mkdirSync(assetsDir, { recursive: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create directories' });
  }

  const assetMap = {};
  const usedFilenames = new Set();

  try {
    console.log(`[${jobId}] Starting pure static clone of ${url}`);
    
    const browser = await chromium.launch({ 
      headless: true,
      args: ['--disable-blink-features=AutomationControlled']
    });
    
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      bypassCSP: true,
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
      // Disable JavaScript? No, we need it to render the page fully first.
    });

    const page = await context.newPage();

    // Intercept requests – save only non-script assets
    await page.route('**/*', async (route) => {
      const request = route.request();
      const resourceType = request.resourceType();
      const reqUrl = request.url();
      
      // SKIP ALL SCRIPT FILES (including module/nomodule)
      if (resourceType === 'script') {
        route.continue();
        return;
      }
      
      // Save stylesheets, images, fonts, media
      if (['stylesheet', 'image', 'font', 'media'].includes(resourceType)) {
        try {
          const response = await page.request.fetch(reqUrl, { 
            timeout: 10000,
            maxRetries: 1
          });
          
          const buffer = await response.body();
          const mime = response.headers()['content-type'] || '';
          
          let desiredName = getSafeFilename(reqUrl, mime, resourceType);
          
          let finalName = desiredName;
          let counter = 1;
          while (usedFilenames.has(finalName)) {
            const parsed = path.parse(desiredName);
            finalName = `${parsed.name}_${counter}${parsed.ext}`;
            counter++;
          }
          usedFilenames.add(finalName);
          
          const filepath = path.join(assetsDir, finalName);
          fs.writeFileSync(filepath, buffer);
          assetMap[reqUrl] = `assets/${finalName}`;
          
          console.log(`[${jobId}] Saved: ${finalName}`);
        } catch (e) {
          console.warn(`[${jobId}] Failed: ${reqUrl} - ${e.message}`);
        }
      }
      
      route.continue();
    });

    console.log(`[${jobId}] Navigating...`);
    await page.goto(url, { 
      waitUntil: 'networkidle',
      timeout: 30000 
    });

    await page.waitForTimeout(2000);

    console.log(`[${jobId}] Scrolling to load lazy content...`);
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 150;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
    });
    
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1500);

    const finalHtml = await page.content();
    
    // Sanitize HTML (remove all JS, rewrite URLs)
    const cleanHtml = sanitizeHtml(finalHtml, assetMap);
    
    fs.writeFileSync(path.join(jobDir, 'index.html'), cleanHtml);

    await browser.close();

    console.log(`[${jobId}] Done. ${Object.keys(assetMap).length} assets saved.`);

    // Create ZIP
    const zipPath = path.join(CLONE_DIR, `${jobId}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      archive.on('error', reject);
      
      archive.pipe(output);
      archive.directory(jobDir, false);
      archive.finalize();
    });

    fs.rmSync(jobDir, { recursive: true, force: true });

    res.json({ 
      success: true, 
      jobId,
      downloadUrl: `/download/${jobId}`,
      message: `Static clone ready. Zero JavaScript. ${Object.keys(assetMap).length} assets.`
    });

  } catch (err) {
    console.error(`[${jobId}] Error:`, err);
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

app.get('/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const zipPath = path.join(CLONE_DIR, `${jobId}.zip`);
  
  if (fs.existsSync(zipPath)) {
    res.download(zipPath, `clone-${jobId}.zip`);
  } else {
    res.status(404).send('Clone not found or expired');
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`🚀 Pure Static Cloner running on http://localhost:${PORT}`);
  console.log(`📁 Clones: ${CLONE_DIR}`);
  console.log(`🧹 All JavaScript is stripped – 100% static output.`);
});
