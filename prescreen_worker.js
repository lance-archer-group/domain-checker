const axios = require("axios");
const { parentPort, workerData } = require("worker_threads");

// ✅ Define page size limits
const MIN_PAGE_SIZE = 1500; // 1.5 KB (Filter out tiny pages)
const MAX_PAGE_SIZE = 2 * 1024 * 1024; // 2 MB (Filter out massive pages)

// ✅ Keywords indicating a parked domain
const PARKED_KEYWORDS = [
    "domain for sale", "buy this domain", "this domain is parked",
    "advertising space", "parking service", "available for purchase",
    "sedo", "afternic"
];

// ✅ Function to check a website with page size filtering
async function checkWebsite(domainData) {
    if (!domainData || !domainData.domain || !domainData.list_number) {
        console.error("❌ Invalid domainData received:", domainData);
        return { domain: "unknown", list_number: "unknown", status: "error", error: "Invalid domain data", parked: true };
    }

    const domain = domainData.domain.trim();
    const list_number = domainData.list_number.trim();
    let status, pageSize, pageContent = "";

    console.log(`🟡 [Worker ${process.pid}] Checking: ${domain} (List #${list_number})`);

    try {
        if (!domain.startsWith("http")) {
            domainData.domain = `http://${domain}`;
        }

        // ✅ Send request (without full download)
        const response = await axios.get(domainData.domain, {
            timeout: 5000, // 5s timeout
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
            },
            maxContentLength: MAX_PAGE_SIZE // Avoid downloading very large pages
        });

        status = response.status;
        pageSize = response.headers["content-length"] ? parseInt(response.headers["content-length"], 10) : response.data.length;

        // ✅ Skip if the page is too small (likely parked/empty)
        if (pageSize < MIN_PAGE_SIZE) {
            console.log(`❌ [Worker ${process.pid}] ${domain} → Skipped (Too Small: ${pageSize} bytes)`);
            return { domain, list_number, status, error: `Skipped (Too Small: ${pageSize} bytes)`, parked: true };
        }

        // ✅ Skip if the page is too large (not relevant)
        if (pageSize > MAX_PAGE_SIZE) {
            console.log(`❌ [Worker ${process.pid}] ${domain} → Skipped (Too Large: ${pageSize} bytes)`);
            return { domain, list_number, status, error: `Skipped (Too Large: ${pageSize} bytes)`, parked: false };
        }

        pageContent = response.data.toLowerCase(); // ✅ Store page HTML

        // ✅ If 404, mark as parked
        if (status === 404) {
            console.log(`❌ [Worker ${process.pid}] ${domain} → 404 Not Found`);
            return { domain, list_number, status: 404, error: "Page Not Found", parked: true };
        }

    } catch (error) {
        console.log(`❌ [Worker ${process.pid}] Error on ${domain}: ${error.message}`);
        return { 
            domain, 
            list_number, 
            status: "error", 
            error: error.code || error.message, 
            parked: true 
        };
    }

    // ✅ Check for parked domain indicators in the page content
    const isParked = PARKED_KEYWORDS.some(keyword => pageContent.includes(keyword));

    console.log(`✅ [Worker ${process.pid}] Completed: ${domain} → Status: ${status}, Page Size: ${pageSize} bytes, Parked: ${isParked}`);
    return { domain, list_number, status, pageSize, parked: isParked };
}

// ✅ Process domains in worker and ensure it closes
(async () => {
    console.log(`🔄 Worker ${process.pid} processing ${workerData.domains.length} domains...`);

    try {
        // ✅ Run all domain checks in parallel using `Promise.allSettled()` to avoid hanging
        const results = await Promise.allSettled(workerData.domains.map(checkWebsite));

        // ✅ Convert results into a simple array (resolve/reject handling)
        const formattedResults = results.map(res => res.status === "fulfilled" ? res.value : {
            domain: "unknown",
            list_number: "unknown",
            status: "error",
            error: "Worker error",
            parked: true
        });

        parentPort.postMessage(formattedResults);
    } catch (err) {
        console.error(`❌ [Worker ${process.pid}] Fatal Error: ${err.message}`);
    } finally {
        console.log(`🔴 [Worker ${process.pid}] Shutting down.`);
        process.exit(0); // ✅ Force worker to exit
    }
})();
