const workerpool = require("workerpool");
const { fetch } = require("undici");
const dns = require("dns").promises;

const PARKED_KEYWORDS = [
    "domain for sale", "buy this domain", "this domain is parked",
    "advertising space", "parking service", "available for purchase",
    "sedo", "afternic"
];

const MIN_PAGE_SIZE = 500 * 1024; // 500 KB

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
        if (contentLength) {
            pageSize = parseInt(contentLength, 10);
        } else {
            // ✅ Fallback: Measure raw response body size (more accurate)
            const bodyBuffer = await response.arrayBuffer();
            pageSize = bodyBuffer.byteLength;
        }

        // ✅ Check for parked keywords (convert buffer to string safely)
        const pageContent = Buffer.from(await response.arrayBuffer()).toString("utf-8").toLowerCase();
        if (PARKED_KEYWORDS.some(keyword => pageContent.includes(keyword))) {
            errorReason = "Detected as parked";
        }

        if (pageSize < MIN_PAGE_SIZE) {
            errorReason = "Page size too small";
        }

        const isParked = errorReason !== "";

        console.log(`✅ [Worker ${process.pid}] Completed: ${domain} → Status: ${status}, Page Size: ${(pageSize / 1024).toFixed(2)} KB, Parked: ${isParked}, Error: ${errorReason || "None"}`);

        return { domain, list_number, status, parked: isParked, pageSize: (pageSize / 1024).toFixed(2), error_reason: errorReason || "None" };
    } catch (error) {
        return { domain, list_number, status: "error", error_reason: error.message, parked: true, pageSize: 0 };
    }
}

workerpool.worker({ checkWebsite });
