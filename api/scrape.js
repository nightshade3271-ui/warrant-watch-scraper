const chromium = require('@sparticuz/chromium-min');
const puppeteer = require('puppeteer-core');

module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { first, last } = req.query;

  if (!first || !last) {
    return res.status(400).json({ success: false, error: 'Missing query parameters: first, last' });
  }

  let browser = null;
  try {
    const isLocal = process.env.NODE_ENV === 'development';
    
    const executablePath = isLocal 
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' // Local Chrome path for Windows testing
      : await chromium.executablePath('https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar');

    const path = require('path');
    const execDir = isLocal ? '' : path.dirname(executablePath);
    if (!isLocal) {
      process.env.LD_LIBRARY_PATH = execDir;
    }

    browser = await puppeteer.launch({
      args: isLocal ? [] : chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: isLocal ? true : chromium.headless,
      ignoreHTTPSErrors: true,
      env: {
        ...process.env,
        LD_LIBRARY_PATH: isLocal ? process.env.LD_LIBRARY_PATH : execDir
      }
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log('Navigating to Montgomery County PRO site...');
    await page.goto('https://pro.mcohio.org/', { waitUntil: 'networkidle2', timeout: 25000 });

    // Accept disclaimer modal if present
    try {
      const acceptBtn = await page.waitForSelector('button[onclick*="acceptDisclaimer"]', { timeout: 3000 });
      if (acceptBtn) {
        await acceptBtn.click();
        console.log('Disclaimer accepted.');
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    } catch (e) {
      console.log('Disclaimer modal not found or already accepted, proceeding.');
    }

    // Wait for the Name search input fields
    await page.waitForSelector('#gen_last_name', { timeout: 8000 });
    await page.type('#gen_last_name', last.trim());
    await page.type('#gen_first_name', first.trim());

    // Click the General Search submit button
    console.log('Submitting query...');
    await page.click('#frmGenSearch button.btn-success');

    // Wait for the results content to load
    console.log('Waiting for results...');
    await page.waitForSelector('#Results table, #Results .alert, #Results .text-danger', { timeout: 15000 });

    const pageHtml = await page.content();
    if (pageHtml.includes('No records returned') || pageHtml.includes('No cases match') || pageHtml.includes('0 Records Returned')) {
      console.log('Search returned 0 records.');
      return res.status(200).json({ success: true, data: [] });
    }

    // Parse the records table
    const cases = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#tblSearchResults tr'));
      return rows.map(row => {
        const cols = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
        if (cols.length < 5) return null;
        return {
          case_number: cols[0],
          court: 'Court of Common Pleas',
          charge: cols[1],
          name: cols[2],
          dob: cols[3],
          status: cols[4],
          warrant: 'No'
        };
      }).filter(Boolean);
    });

    console.log(`Scrape finished. Found ${cases.length} cases.`);
    return res.status(200).json({ success: true, data: cases });
  } catch (error) {
    console.error('Serverless Scraper Exception:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
};
