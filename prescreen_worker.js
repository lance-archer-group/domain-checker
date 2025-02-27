const workerpool = require("workerpool");
const { fetch } = require("undici");
const dns = require("dns").promises;

// Page size limits
const MIN_PAGE_SIZE = 1500;   // 5 KB
const MAX_PAGE_SIZE = 5 * 1024 * 1024; // 5 MB

// Terms to filter out in final URL
const FILTERED_TERMS = ["domain",
    "afternic", 
    "parking", 
    "sedo", 
    ".mx", 
    "amazon.com", 
    "ebay.com", 
    "etsy.com", 
    "allstate.com", 
    "slicelife.com", 
    "placester.com", 
    "dignitymemorial.com", 
    "car-part.com", 
    "raymondjames.com", 
    "paparazziaccessories.com", 
    "proagentwebsites.com", 
    "vacationstogo.com", 
    "vacasa.com", 
    "marriott.com", 
    "intermountainhealthcare.org", 
    "remax.com", 
    "ets.org", 
    "wyndhamhotels.com", 
    "sawblade.com", 
    "visahq.com", 
    "resortvacationstogo.com"];

// Define an array of accepted English-based language codes "en-gb" "en-ca", "en-au", "en-nz", "en-in"
const ALLOWED_LANGUAGES = ["en", "en-us"];

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
            final_url: "N/A",
            language: "N/A"
        };
    }

    const domain = domainData.domain.trim();
    const list_number = domainData.list_number.trim();
    let status = "unknown",
        pageSize = 0,
        finalUrl = `http://${domain}`;
    
    let language = "N/A";  // Default if no Content-Language header is present

    console.log(`🟡 [Worker ${process.pid}] Checking: ${domain} (List #${list_number})`);

    // Check DNS
    if (!(await checkDNS(domain))) {
        return {
            domain,
            list_number,
            status: "error",
            error_reason: "DNS resolution failed",
            pageSize: 0,
            final_url: "N/A",
            language
        };
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
        finalUrl = response.url.toLowerCase();

        // Check if final URL contains any filtered terms
        if (FILTERED_TERMS.some(term => finalUrl.includes(term))) {
            console.log(`❌ [Worker ${process.pid}] ${domain} → Skipped (Final URL contains a filtered term): ${finalUrl}`);
            return {
                domain,
                list_number,
                status: "error",
                error_reason: `Filtered (Final URL contains a blocked term)`,
                pageSize: 0,
                final_url: finalUrl,
                language
            };
        }

        // Get and validate the language header
        const languageHeader = response.headers.get("content-language");
        if (languageHeader) {
            language = languageHeader.toLowerCase(); // Normalize to lowercase

            // Only filter if language is provided and not in the allowed list
            if (!ALLOWED_LANGUAGES.includes(language)) {
                return {
                    domain,
                    list_number,
                    status: "error",
                    error_reason: `Bad language header (${language})`,  // No extra quotes
                    pageSize: 0,
                    final_url: finalUrl,
                    language
                };
            }
        }

        // Determine page size
        const contentLength = response.headers.get("content-length");
        if (contentLength) {
            pageSize = parseInt(contentLength, 10);
        } else {
            pageSize = Buffer.byteLength(await response.text(), "utf-8");
        }

        if (!pageSize || isNaN(pageSize)) {
            console.log(`⚠️ [Worker ${process.pid}] ${domain} → Page size not detected, assuming 0.`);
            pageSize = 0;
        }

        // Apply page size checks
        if (pageSize < MIN_PAGE_SIZE) {
            return {
                domain,
                list_number,
                status: "error",
                error_reason: `Page size too small (< ${MIN_PAGE_SIZE} bytes)`,
                pageSize,
                final_url: finalUrl,
                language
            };
        }
        if (pageSize > MAX_PAGE_SIZE) {
            return {
                domain,
                list_number,
                status: "error",
                error_reason: `Page size too large (> ${MAX_PAGE_SIZE} bytes)`,
                pageSize,
                final_url: finalUrl,
                language
            };
        }

        console.log(`✅ [Worker ${process.pid}] Completed: ${domain} → Status: ${status}, Page Size: ${pageSize} bytes, Final URL: ${finalUrl}`);

        return { domain, list_number, status, pageSize, final_url: finalUrl, language };
    } catch (error) {
        return {
            domain,
            list_number,
            status: "error",
            error_reason: error.message,
            pageSize: 0,
            final_url: "N/A",
            language
        };
    }
}

workerpool.worker({ checkWebsite });