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
        return { domain: "unknown", list_number: "unknown", status: "error", error_reason: "Invalid domain data", parked: false, pageSize: 0, final_url: "N/A" };
    }

    const domain = domainData.domain.trim();
    const list_number = domainData.list_number.trim();
    let status = "unknown", pageSize = 0, errorReason = "", isParked = false, pageContent = "", finalUrl = `http://${domain}`;

    console.log(`🟡 [Worker ${process.pid}] Checking: ${domain} (List #${list_number})`);

    if (!(await checkDNS(domain))) {
        return { domain, list_number, status: "error", error_reason: "DNS resolution failed", parked: false, pageSize: 0, final_url: "N/A" };
    }

    try {
        const response = await fetch(`http://${domain}`, {
            method: "GET",
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
            },
            redirect: "follow" // ✅ Automatically follows redirects
        });

        status = response.status;
        finalUrl = response.url; // ✅ Capture the final redirected URL

        // ✅ First, try to use Content-Length header
        const contentLength = response.headers.get("content-length");

        if (contentLength) {
            pageSize = parseInt(contentLength, 10);
        } else {
            // ✅ Fallback: Measure raw response body size using text encoding
            pageContent = await response.text();
            pageSize = Buffer.byteLength(pageContent, "utf-8");
        }

        // ✅ Log small pages but DO NOT mark them as parked unless they contain parked keywords
        if (pageSize < MIN_PAGE_SIZE) {
            console.log(`⚠️ [Worker ${process.pid}] ${domain} → Small page (${pageSize} bytes), but not automatically parked.`);
        }

        // ✅ Skip if the page is too large (not relevant)
        if (pageSize > MAX_PAGE_SIZE) {
            console.log(`❌ [Worker ${process.pid}] ${domain} → Skipped (Too Large: ${pageSize} bytes)`);
            return { domain, list_number, status, error: `Skipped (Too Large: ${pageSize} bytes)`, parked: false, pageSize, final_url: finalUrl };
        }

        // ✅ Load page content only if not already fetched
        if (!pageContent) {
            pageContent = await response.text();
        }

        // ✅ Mark as parked ONLY if keywords match
        isParked = PARKED_KEYWORDS.some(keyword => pageContent.includes(keyword));

        console.log(`✅ [Worker ${process.pid}] Completed: ${domain} → Status: ${status}, Page Size: ${pageSize} bytes, Parked: ${isParked}, Final URL: ${finalUrl}`);

        return { domain, list_number, status, pageSize, parked: isParked, final_url: finalUrl };
    } catch (error) {
        return { domain, list_number, status: "error", error_reason: error.message, parked: false, pageSize: 0, final_url: "N/A" };
    }
}

workerpool.worker({ checkWebsite });
