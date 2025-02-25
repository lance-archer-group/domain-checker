const axios = require("axios");
const puppeteer = require("puppeteer");
const { parentPort, workerData } = require("worker_threads");

// Keywords indicating a parked domain
const PARKED_KEYWORDS = [
    "domain for sale", "coming soon", "buy this domain", "this domain is parked",
    "is for sale", "available for purchase", "sedo", "afternic", "parking page",
    "advertising space", "parking service"
];

// Function to check a website
async function checkWebsite(url, retry = false) {
    let browser;
    try {
        if (!url.startsWith("http")) {
            url = `http://${url}`;
        }

        // Fetch HTTP status
        let status;
        try {
            const response = await axios.get(url, { timeout: 10000 });
            status = response.status;

            // Skip Puppeteer if status is 404
            if (status === 404) {
                return { url, status: 404, error: "Page Not Found", parked: true };
            }
        } catch (error) {
            if (error.code === "ENOTFOUND") return { url, status: "error", error: "Domain not found", parked: true };
            if (error.code === "ECONNREFUSED") return { url, status: "error", error: "Connection refused", parked: true };
            if (error.code === "ETIMEDOUT") {
                if (!retry) return await checkWebsite(url, true); // Retry once
                return { url, status: "error", error: "Timeout exceeded", parked: true };
            }
            if (error.response && error.response.status === 403) return { url, status: 403, error: "Blocked by website", parked: true };
            return { url, status: "error", error: error.message, parked: true };
        }

        // Launch Puppeteer (headless browser)
        browser = await puppeteer.launch({
            headless: "new",
            args: ["--disable-features=BlockInsecurePrivateNetworkRequests"]
        });

        const page = await browser.newPage();
        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
        );

        await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });

        // Extract page title & meta description
        const title = await page.title();
        const metaDescription = await page.$eval("meta[name='description']", el => el.content).catch(() => "");

        // Check for parked domain indicators
        const pageContent = `${title} ${metaDescription}`.toLowerCase();
        const isParked = PARKED_KEYWORDS.some(keyword => pageContent.includes(keyword));

        return { url, status, title, metaDescription, parked: isParked };

    } catch (error) {
        return { url, status: "error", error: error.message, parked: true };
    } finally {
        if (browser) await browser.close();
    }
}

// Run checks for the assigned chunk of domains
(async () => {
    const results = [];
    for (let domain of workerData.domains) {
        const result = await checkWebsite(domain);
        results.push(result);
    }
    parentPort.postMessage(results);
})();
