const axios = require("axios");
const { parentPort, workerData } = require("worker_threads");

// ✅ Define page size limits
const MIN_PAGE_SIZE = 1500; // 1.5 KB (Filter out tiny pages)
const MAX_PAGE_SIZE = 2 * 1024 * 1024; // 2 MB (Filter out massive pages)

// ✅ Set concurrency limit per worker
const MAX_CONCURRENT_REQUESTS = 5;

// ✅ Keywords indicating a parked domain
const PARKED_KEYWORDS = [
    "domain for sale", "buy this domain", "this domain is parked",
    "advertising space", "parking service", "available for purchase",
    "sedo", "afternic"
];

// ✅ Function to check a website with retry logic
async function checkWebsite(domainData) {
    if (!domainData || !domainData.domain || !domainData.list_number) {
        console.error("❌ Invalid domainData received:", domainData);
        return { domain: "unknown", list_number: "unknown", status: "error", error: "Invalid domain data", parked: true };
    }

    const domain = domainData.domain.trim();
    const list_number = domainData.list_number.trim();
    let status, pageSize, pageContent = "";

    console.log(`🟡 [Worker ${process.pid}] Checking: ${domain} (List #${list_number})`);

    if (!domain.startsWith("http")) {
        domainData.domain = `http://${domain}`;
    }

    const requestConfig = {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
        },
        maxContentLength: MAX_PAGE_SIZE // Avoid downloading very large pages
    };

    // ✅ First attempt with 5s timeout
    try {
        const response = await axios.get(domainData.domain, { ...requestConfig, timeout: 5000 });
        status = response.status;
        pageSize = response.headers["content-length"] ? parseInt(response.headers["content-length"], 10) : response.data.length;
        pageContent = response.data.toLowerCase();
    } catch (error) {
        if (error.code === "ETIMEDOUT" || error.code === "ECONNRESET") {
            console.log(`🔄 [Worker ${process.pid}] Retrying ${domain} with 10s timeout...`);
            try {
                const response = await axios.get(domainData.domain, { ...requestConfig, timeout: 10000 });
                status = response.status;
                pageSize = response.headers["content-length"] ? parseInt(response.headers["content-length"], 10) : response.data.length;
                pageContent = response.data.toLowerCase();
            } catch (secondError) {
                console.log(`❌ [Worker ${process.pid}] ${domain} failed after retry: ${secondError.message}`);
                return { domain, list_number, status: "error", error: secondError.message, parked: true };
            }
        } else {
            console.log(`❌ [Worker ${process.pid}] ${domain} error: ${error.message}`);
            return { domain, list_number, status: "error", error: error.message, parked: true };
        }
    }

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

    // ✅ Check for parked domain indicators in the page content
    const isParked = PARKED_KEYWORDS.some(keyword => pageContent.includes(keyword));

    console.log(`✅ [Worker ${process.pid}] Completed: ${domain} → Status: ${status}, Page Size: ${pageSize} bytes, Parked: ${isParked}`);
    return { domain, list_number, status, pageSize, parked: isParked };
}

// ✅ Process all domains in parallel with concurrency control
async function processDomains() {
    console.log(`🔄 Worker ${process.pid} processing ${workerData.domains.length} domains...`);

    const results = [];
    const queue = [...workerData.domains];

    while (queue.length > 0) {
        const batch = queue.splice(0, MAX_CONCURRENT_REQUESTS);
        const batchResults = await Promise.allSettled(batch.map(checkWebsite));
        
        results.push(
            ...batchResults.map(res => res.status === "fulfilled" ? res.value : {
                domain: "unknown",
                list_number: "unknown",
                status: "error",
                error: "Worker error",
                parked: true
            })
        );

        console.log(`🔄 [Worker ${process.pid}] Processed ${results.length}/${workerData.domains.length}`);
    }

    return results;
}

// ✅ Run processing and ensure worker exits
(async () => {
    try {
        const results = await processDomains();
        parentPort.postMessage(results);
    } catch (err) {
        console.error(`❌ [Worker ${process.pid}] Fatal Error: ${err.message}`);
    } finally {
        console.log(`🔴 [Worker ${process.pid}] Shutting down.`);
        process.exit(0);
    }
})();
