process.env.AWS_LAMBDA_JS_RUNTIME = 'nodejs22.x';
const chromium = require('@sparticuz/chromium');
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

  const { first, last, platform, url } = req.query;

  if (!first || !last) {
    return res.status(400).json({ success: false, error: 'Missing query parameters: first, last' });
  }

  let browser = null;
  try {
    const isLocal = process.env.NODE_ENV === 'development';
    
    const executablePath = isLocal 
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' // Local Chrome path for Windows testing
      : await chromium.executablePath();

    browser = await puppeteer.launch({
      args: isLocal ? [] : chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: isLocal ? true : chromium.headless,
      ignoreHTTPSErrors: true
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    const isOdyssey = (platform && platform.toLowerCase().includes('odyssey')) || 
                      (url && url.toLowerCase().includes('tylerhost.net'));

    if (isOdyssey && url) {
      console.log(`Navigating to Tyler Odyssey Portal: ${url}`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });

      // Look for Smart Search button or link
      let smartSearchUrl = url;
      if (!url.toLowerCase().includes('smartsearch') && !url.toLowerCase().includes('workspacemode')) {
        const hasSmartSearchLink = await page.evaluate(() => {
          const link = document.querySelector('a[href*="SmartSearch"], a[href*="WorkspaceMode"]');
          return link ? link.href : null;
        });
        if (hasSmartSearchLink) {
          smartSearchUrl = hasSmartSearchLink;
        } else {
          // Fallback guess
          smartSearchUrl = url.endsWith('/') ? `${url}Home/WorkspaceMode?rt=Search` : `${url}/Home/WorkspaceMode?rt=Search`;
        }
      }

      console.log(`Navigating to Smart Search: ${smartSearchUrl}`);
      await page.goto(smartSearchUrl, { waitUntil: 'networkidle2', timeout: 25000 });

      // Handle disclaimer if present
      try {
        const acceptBtn = await page.waitForSelector('input[type="submit"][value*="Accept"], button[id*="accept"], .btn-primary', { timeout: 3000 });
        if (acceptBtn) {
          await acceptBtn.click();
          console.log('Disclaimer accepted.');
          await new Promise(resolve => setTimeout(resolve, 800));
        }
      } catch (e) {
        console.log('No disclaimer found, proceeding.');
      }

      // Wait for the Smart Search input
      const searchInputSelector = await Promise.race([
        page.waitForSelector('#txtSmartSearch', { timeout: 8000 }).then(() => '#txtSmartSearch'),
        page.waitForSelector('#SmartSearchText', { timeout: 8000 }).then(() => '#SmartSearchText'),
        page.waitForSelector('input[name*="SearchText"]', { timeout: 8000 }).then(() => 'input[name*="SearchText"]')
      ]);

      console.log(`Found search input selector: ${searchInputSelector}`);
      // Odyssey standard format: Last Name, First Name
      await page.type(searchInputSelector, `${last.trim()}, ${first.trim()}`);

      // Click search button
      const searchBtnSelector = await Promise.race([
        page.waitForSelector('#btnSearch', { timeout: 3000 }).then(() => '#btnSearch'),
        page.waitForSelector('#btnSmartSearch', { timeout: 3000 }).then(() => '#btnSmartSearch'),
        page.waitForSelector('.search-btn', { timeout: 3000 }).then(() => '.search-btn'),
        page.waitForSelector('input[type="submit"]', { timeout: 3000 }).then(() => 'input[type="submit"]')
      ]);

      console.log(`Clicking search button: ${searchBtnSelector}`);
      await page.click(searchBtnSelector);

      // Wait for search results
      console.log('Waiting for search results...');
      await page.waitForSelector('#searchResultsTable, .k-grid-content, .search-results, #g-cases, td.case-link, a[href*="CaseID"]', { timeout: 15000 });

      // Parse results
      const cases = await page.evaluate((courtName) => {
        const rows = Array.from(document.querySelectorAll('tr'));
        return rows.map(row => {
          const caseLink = row.querySelector('a[href*="CaseID"], td.case-link a');
          if (!caseLink) return null;
          
          const cols = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
          if (cols.length === 0) return null;

          const caseNum = caseLink.innerText.trim();
          let status = 'CLOSED';
          let charge = 'Court Case Record';
          
          cols.forEach(col => {
            if (col.toLowerCase() === 'open' || col.toLowerCase() === 'active') {
              status = 'OPEN';
            }
            if (col.toLowerCase().includes('criminal') || col.toLowerCase().includes('traffic')) {
              charge = col;
            }
          });

          return {
            case_number: caseNum,
            court: courtName || 'District/County Court',
            charge: charge,
            name: cols[1] || 'Subject Record',
            dob: '',
            status: status,
            warrant: 'No'
          };
        }).filter(Boolean);
      }, req.query.court);

      console.log(`Odyssey scrape finished. Found ${cases.length} cases.`);
      return res.status(200).json({ success: true, data: cases });
    } else {
      // Default: Montgomery County PRO scraper
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

      console.log(`Montgomery PRO scrape finished. Found ${cases.length} cases.`);
      return res.status(200).json({ success: true, data: cases });
    }
  } catch (error) {
    console.error('Serverless Scraper Exception:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
};
