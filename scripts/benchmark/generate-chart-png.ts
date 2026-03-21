/**
 * Script to generate benchmark chart PNG from HTML using Puppeteer
 */
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function generateChart() {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    
    const htmlPath = join(__dirname, '../../docs/benchmark-scaling-chart.html');
    const pngPath = join(__dirname, '../../docs/benchmark-scaling-chart.png');
    
    console.log('Loading HTML file:', htmlPath);
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });
    
    // Wait for charts to render
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log('Taking screenshot...');
    await page.screenshot({
        path: pngPath,
        fullPage: true
    });
    
    await browser.close();
    console.log('Chart saved to:', pngPath);
}

generateChart().catch(console.error);
