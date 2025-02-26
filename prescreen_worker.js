const workerpool = require("workerpool");
const { fetch } = require("undici");
const dns = require("dns").promises;

// ✅ Keywords indicating a parked domain
const PARKED_KEYWORDS = [
    "domain for sale", "buy this domain", "this domain is parked",
    "advertising space", "parking service", "available for purchase",
    "sedo", "afternic"
];

// ✅ Minimum page size (in bytes)
const MIN_PAGE_SIZE = 1500 * 1024; // 1500 KB

// ✅ Function to check DNS before making requests
async function checkDNS(domain) {
    try {
        await dns.resolve(domain);
        return true;
    } catch {
        return false;
    }
}

// ✅ Function to check website
async function checkWebsite(domainData) {
    if (!domainData || !domainData.domain || !domainData.list_number) {
        console.error("❌ Invalid domainData received:", domainData);
        return { domain: "unknown", list_number: "unknown", status: "error", error: "Invalid domain data", parked: true, pageSize: 0 };
    }

    const domain = domainData.domain.trim();
    const list_number = domainData.list_number.trim();
    let status, pageContent = "", pageSize = 0;

    console.log(`🟡 [Worker ${process.pid}] Checking: ${domain} (List #${list_number})`);

    // ✅ Check if domain has a valid DNS record before requesting
    if (!(await checkDNS(domain))) {
        console.log(`❌ [Worker ${process.pid}] ${domain} does not resolve.`);
        return { domain, list_number, status: "error", error: "DNS resolution failed", parked: true, pageSize: 0 };
    }

    try {
        const response = await fetch(`http://${domain}`, {
            method: "GET",
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
            }
        });

        status = response.status;

        // ✅ Get page size from content-length header (if available)
        const contentLength = response.headers.get("content-length");
        if (contentLength) {
            pageSize = parseInt(contentLength, 10);
        } else {
            // ✅ Fallback: Measure content size manually
            pageContent = await response.text();
            pageSize = Buffer.byteLength(pageContent, "utf-8");
        }

        // ✅ If page is too small, mark as parked
        const isParked = pageSize < MIN_PAGE_SIZE || PARKED_KEYWORDS.some(keyword => pageContent.includes(keyword));

        console.log(`✅ [Worker ${process.pid}] Completed: ${domain} → Status: ${status}, Page Size: ${(pageSize / 1024).toFixed(2)} KB, Parked: ${isParked}`);

        return { domain, list_number, status, parked: isParked, pageSize: (pageSize / 1024).toFixed(2) };
    } catch (error) {
        console.log(`❌ [Worker ${process.pid}] Error on ${domain}: ${error.message}`);
        return { domain, list_number, status: "error", error: error.message, parked: true, pageSize: 0 };
    }
}

// ✅ Expose function to worker pool
workerpool.worker({ checkWebsite });
