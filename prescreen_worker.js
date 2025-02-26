const workerpool = require("workerpool");
const { fetch } = require("undici");
const dns = require("dns").promises;

// Reintroduce page size checks.
const MIN_PAGE_SIZE = 1500;   // 5 KB
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
        return {
            domain: "unknown",
            list_number: "unknown",
            status: "error",
            error_reason: "Invalid domain data",
            pageSize: 0,
            final_url: "N/A"
        };
    }

    const domain = domainData.domain.trim();
    const list_number = domainData.list_number.trim();
    let status = "unknown",
        pageSize = 0,
        errorReason = "",
        pageContent = "",
        finalUrl = `http://${domain}`;

    console.log(`🟡 [Worker ${process.pid}] Checking: ${domain} (List #${list_number})`);

    // Check DNS
    if (!(await checkDNS(domain))) {
        return {
            domain,
            list_number,
            status: "error",
            error_reason: "DNS resolution failed",
            pageSize: 0,
            final_url: "N/A"
        };
    }

    try {
        // Follow redirects, so finalUrl and pageSize correspond to the last page that loads
        const response = await fetch(`http://${domain}`, {
            method: "GET",
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
            },
            redirect: "follow"
        });

        status = response.status;
        finalUrl = response.url.toLowerCase();

        // Filter based on final URL (unchanged).
        if (finalUrl.includes("domain") || finalUrl.includes("afternic")) {
            console.log(
                `❌ [Worker ${process.pid}] ${domain} → Skipped (Final URL contains "domain" or "afternic"): ${finalUrl}`
            );
            return {
                domain,
                list_number,
                status: "error",
                error_reason: `Filtered (Final URL contains "domain" or "afternic")`,
                pageSize: 0,
                final_url: finalUrl
            };
        }

        // Determine page size for the final page
        const contentLength = response.headers.get("content-length");
        if (contentLength) {
            pageSize = parseInt(contentLength, 10);
        } else {
            pageContent = await response.text();
            pageSize = Buffer.byteLength(pageContent, "utf-8");
        }

        if (!pageSize || isNaN(pageSize)) {
            console.log(
                `⚠️ [Worker ${process.pid}] ${domain} → Page size not detected, assuming 0.`
            );
            pageSize = 0;
        }

        // Now apply min/max checks on the final page size
        if (pageSize < MIN_PAGE_SIZE) {
            return {
                domain,
                list_number,
                status: "error",
                error_reason: `Page size too small (< ${MIN_PAGE_SIZE} bytes)`,
                pageSize,
                final_url: finalUrl
            };
        }
        if (pageSize > MAX_PAGE_SIZE) {
            return {
                domain,
                list_number,
                status: "error",
                error_reason: `Page size too large (> ${MAX_PAGE_SIZE} bytes)`,
                pageSize,
                final_url: finalUrl
            };
        }

        console.log(
            `✅ [Worker ${process.pid}] Completed: ${domain} → Status: ${status}, Page Size: ${pageSize} bytes, Final URL: ${finalUrl}`
        );

        return { domain, list_number, status, pageSize, final_url: finalUrl };
    } catch (error) {
        return {
            domain,
            list_number,
            status: "error",
            error_reason: error.message,
            pageSize: 0,
            final_url: "N/A"
        };
    }
}

workerpool.worker({ checkWebsite });
