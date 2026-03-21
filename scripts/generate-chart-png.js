const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

async function generatePNG() {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    
    // Set viewport for consistent rendering
    await page.setViewport({
        width: 1400,
        height: 900,
        deviceScaleFactor: 2
    });
    
    const htmlPath = path.join(__dirname, '..', 'docs', 'benchmark-scaling-chart.html');
    const absolutePath = path.resolve(htmlPath);
    
    console.log('Loading HTML file:', absolutePath);
    await page.goto(`file://${absolutePath}`, { waitUntil: 'networkidle0' });
    
    // Wait for charts to render
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Generate PNG
    const outputPath = htmlPath.replace('.html', '.png');
    await page.screenshot({
        path: outputPath,
        fullPage: true,
        omitBackground: false
    });
    
    console.log('PNG generated:', outputPath);
    
    await browser.close();
}

generatePNG().catch(err => {
    console.error('Error generating PNG:', err);
    process.exit(1);
});
