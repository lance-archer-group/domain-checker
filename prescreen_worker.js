const workerpool = require("workerpool");
const { fetch } = require("undici");
const dns = require("dns").promises;

const PARKED_KEYWORDS = [
    "domain for sale", "buy this domain", "this domain is parked",
    "advertising space", "parking service", "available for purchase",
    "sedo", "afternic"
];

const MIN_PAGE_SIZE = 500 * 1024; // 500 KB
const MAX_PAGE_SIZE = 5 * 1024 * 1024; // 5 MB

async function checkDNS(domain) {
    try {
        await dns.resolve(domain);
        return true;
    } catch {
        return false;
    }
}

async function checkWebsite(domainData) {
    if (!domainData || !domainData.domain || !domainData.list_number) {
        return { domain: "unknown", list_number: "unknown", status: "error", error_reason: "Invalid domain data", parked: true, pageSize: 0 };
    }

    const domain = domainData.domain.trim();
    const list_number = domainData.list_number.trim();
    let status = "unknown", pageSize = 0, errorReason = "";

    console.log(`🟡 [Worker ${process.pid}] Checking: ${domain} (List #${list_number})`);

    if (!(await checkDNS(domain))) {
        return { domain, list_number, status: "error", error_reason: "DNS resolution failed", parked: true, pageSize: 0 };
    }

    try {
        const response = await fetch(`http://${domain}`, {
            method: "GET",
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
            }
        });

        status = response.status;

        // ✅ First, try to use Content-Length header
        const contentLength = response.headers.get("content-length");
        let pageContent = "";

        if (contentLength) {
            pageSize = parseInt(contentLength, 10);
        } else {
            // ✅ Fallback: Measure raw response body size using text encoding
            pageContent = await response.text();
            pageSize = Buffer.byteLength(pageContent, "utf-8");
        }

        // ✅ Skip if the page is too small (likely parked/empty)
        if (pageSize < MIN_PAGE_SIZE) {
            console.log(`❌ [Worker ${process.pid}] ${domain} → Skipped (Too Small: ${pageSize} bytes)`);
            return { domain, list_number, status, error: `Skipped (Too Small: ${pageSize} bytes)`, parked: true, pageSize };
        }

        // ✅ Skip if the page is too large (not relevant)
        if (pageSize > MAX_PAGE_SIZE) {
            console.log(`❌ [Worker ${process.pid}] ${domain} → Skipped (Too Large: ${pageSize} bytes)`);
            return { domain, list_number, status, error: `Skipped (Too Large: ${pageSize} bytes)`, parked: false, pageSize };
        }

        // ✅ Check for parked domain indicators in the page content
        if (!pageContent) {
            pageContent = await response.text();
        }

        const isParked = PARKED_KEYWORDS.some(keyword => pageContent.includes(keyword));

        console.log(`✅ [Worker ${process.pid}] Completed: ${domain} → Status: ${status}, Page Size: ${pageSize} bytes, Parked: ${isParked}`);

        return { domain, list_number, status, pageSize, parked: isParked };
    } catch (error) {
        return { domain, list_number, status: "error", error_reason: error.message, parked: true, pageSize: 0 };
    }
}

workerpool.worker({ checkWebsite });
