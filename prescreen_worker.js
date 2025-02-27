const workerpool = require("workerpool");
const { fetch } = require("undici");
const dns = require("dns").promises;

// Page size limits
const MIN_PAGE_SIZE = 1500;   // 5 KB
const MAX_PAGE_SIZE = 5 * 1024 * 1024; // 5 MB

// Terms to filter out in final URL
const FILTERED_TERMS = [
    "domain", "atom.com", "dynadot.com", "afternic", "parking", "sedo", 
    ".mx", "amazon.com", "ebay.com", "etsy.com", "allstate.com", "slicelife.com",
    "placester.com", "dignitymemorial.com", "car-part.com", "raymondjames.com",
    "paparazziaccessories.com", "proagentwebsites.com", "vacationstogo.com",
    "vacasa.com", "marriott.com", "intermountainhealthcare.org", "remax.com",
    "ets.org", "wyndhamhotels.com", "sawblade.com", "visahq.com", 
    "resortvacationstogo.com", ".uk", ".de", ".ru", ".ch", ".nl", ".it", 
    ".fr", ".se", ".cn", ".pl", ".eu", ".br", ".jp", ".au",
    "clickfunnels.com", "chaturbate.com", "instagram.com", "zoneiraq.com"
];

// Define an array of accepted English-based language codes
const ALLOWED_LANGUAGES = ["en", "en-us"];

// Regex to detect ww##. subdomains
const WW_SUBDOMAIN_REGEX = /\bww\d+\./;

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

        // **Final URL check - Filtering out blocked domains, TLDs, and ww##. subdomains**
        if (FILTERED_TERMS.some(term => finalUrl.includes(term)) || WW_SUBDOMAIN_REGEX.test(finalUrl)) {
            console.log(`❌ [Worker ${process.pid}] ${domain} → Skipped (Blocked by filter): ${finalUrl}`);
            return {
                domain,
                list_number,
                status: "error",
                error_reason: "Filtered (Final URL contains a blocked term or ww##. subdomain)",
                pageSize: 0,
                final_url: finalUrl,
                language
            };
        }

        // **Get and validate the language header**
        const languageHeader = response.headers.get("content-language");
        if (languageHeader) {
            language = languageHeader.toLowerCase(); // Normalize to lowercase

            // **Reject site if its language is NOT allowed**
            if (!ALLOWED_LANGUAGES.includes(language)) {
                return {
                    domain,
                    list_number,
                    status: "error",
                    error_reason: `Bad language header (${language})`,
                    pageSize: 0,
                    final_url: finalUrl,
                    language
                };
            }
        }

        // **Determine page size**
        const contentLength = response.headers.get("content-length");
        pageSize = contentLength ? parseInt(contentLength, 10) : Buffer.byteLength(await response.text(), "utf-8");

        if (!pageSize || isNaN(pageSize)) {
            console.log(`⚠️ [Worker ${process.pid}] ${domain} → Page size not detected, assuming 0.`);
            pageSize = 0;
        }

        // **Apply page size checks**
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
