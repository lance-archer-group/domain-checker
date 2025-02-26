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
        return { domain: "unknown", list_number: "unknown", status: "error", error_reason: "Invalid domain data", pageSize: 0, final_url: "N/A" };
    }

    const domain = domainData.domain.trim();
    const list_number = domainData.list_number.trim();
    let status = "unknown", pageSize = 0, errorReason = "", pageContent = "", finalUrl = `http://${domain}`;

    console.log(`🟡 [Worker ${process.pid}] Checking: ${domain} (List #${list_number})`);

    if (!(await checkDNS(domain))) {
        return { domain, list_number, status: "error", error_reason: "DNS resolution failed", pageSize: 0, final_url: "N/A" };
    }

    try {
        const response = await fetch(`http://${domain}`, {
            method: "GET",
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
            },
            redirect: "follow"
        });

        status = response.status;
        finalUrl = response.url;

        const contentLength = response.headers.get("content-length");

        if (contentLength) {
            pageSize = parseInt(contentLength, 10);
        } else {
            pageContent = await response.text();
            pageSize = Buffer.byteLength(pageContent, "utf-8");
        }

        // ✅ Ensure pageSize is correctly assigned
        if (!pageSize || isNaN(pageSize)) {
            console.log(`⚠️ [Worker ${process.pid}] ${domain} → Page size not detected, assuming 0.`);
            pageSize = 0;
        }

        if (pageSize > MAX_PAGE_SIZE) {
            console.log(`❌ [Worker ${process.pid}] ${domain} → Skipped (Too Large: ${pageSize} bytes)`);
            return { domain, list_number, status, error: `Skipped (Too Large: ${pageSize} bytes)`, pageSize, final_url: finalUrl };
        }

        console.log(`✅ [Worker ${process.pid}] Completed: ${domain} → Status: ${status}, Page Size: ${pageSize} bytes, Final URL: ${finalUrl}`);

        return { domain, list_number, status, pageSize, final_url: finalUrl };
    } catch (error) {
        return { domain, list_number, status: "error", error_reason: error.message, pageSize: 0, final_url: "N/A" };
    }
}


workerpool.worker({ checkWebsite });
