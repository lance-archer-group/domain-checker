const workerpool = require("workerpool");
const { fetch } = require("undici");
const dns = require("dns").promises;

const MIN_PAGE_SIZE = 1500; // Minimum page size in bytes (approx 1.5 KB)
const MAX_PAGE_SIZE = 5 * 1024 * 1024; // 5 MB

const ACCEPTED_STATUS_CODES = [200, 301];

const FILTERED_TERMS_GROUPED = {
    general: ["domain", "parking", "hosting"],
    socialMedia: ["discord.com", "youtube.com", "flicker.com", "linkedin.com", "instagram.com", "flipboard.com"],
    marketplaces: ["amazon.com", "ebay.com", "etsy.com", "paparazziaccessories.com"],
    realEstate: ["placester.com", "remax.com", "proagentwebsites.com"],
    hotels: ["marriott.com", "wyndhamhotels.com", "vacasa.com", "vacationstogo.com", "resortvacationstogo.com"],
    financial: ["raymondjames.com", "visahq.com"],
    health: ["intermountainhealthcare.org", "dignitymemorial.com", "allstate.com"],
    techDomains: ["dynadot.com", "afternic", "sedo", "atom.com", "clickfunnels.com"],
    adult: ["chaturbate.com"],
    government: [".gov"],
    TLDs: [".mx", ".uk", ".de", ".ru", ".ch", ".nl", ".it", ".fr", ".se", ".cn", ".pl", ".eu", ".br", ".jp", ".au", ".ca", ".nz"],
    other: ["zoneiraq.com"]
};

// Flatten the grouped terms into one array for filtering.
const FILTERED_TERMS = Object.values(FILTERED_TERMS_GROUPED).flat();

// Only allow these language codes from the Content-Language header.
const ALLOWED_LANGUAGES = ["en", "en-us"];

// Regex to catch subdomains like ww12.
const WW_SUBDOMAIN_REGEX = /\bww\d+\./;

// Terms to detect parking pages.
const HTML_SCRAPE_TERMS = {
    strict: [
        "this domain is for sale",
        "buy this domain",
        "domain for sale",
        "parked free",
        "this site is parked",
        "this page is parked",
        "domain parking",
        "sedoparking",
        "sedo parking",
        "afternic",
        "namecheap marketplace",
        "domain is parked",
        "parking",
        "hosting"
    ],
    regex: [
        /this\s+domain\s+is\s+(currently\s+)?for\s+sale/i,
        /buy\s+this\s+domain/i,
        /this\s+page\s+is\s+parked/i,
        /domain\s+parking/i,
        /sedoparking/i,
        /afternic/i,
        /click\s+here\s+to\s+buy/i
    ]
};

/**
 * Check if the given domain resolves via DNS.
 * @param {string} domain 
 * @returns {Promise<boolean>}
 */
async function checkDNS(domain) {
    try {
        await dns.resolve(domain);
        return true;
    } catch {
        return false;
    }
}

/**
 * Fetches a website and performs several validations:
 * - DNS resolution
 * - HTTP status code
 * - Final URL filtering
 * - Language header verification
 * - Page size boundaries
 * - HTML content filtering (e.g., for parked domains)
 *
 * @param {Object} domainData - Should contain `domain` and `list_number`
 * @returns {Promise<Object>} - The result object with status and details.
 */
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
    const listNumber = domainData.list_number.trim();
    let status = "unknown";
    let pageSize = 0;
    let finalUrl = `http://${domain}`;
    let language = "N/A";

    console.log(`🟡 [Worker ${process.pid}] Checking: ${domain} (List #${listNumber})`);

    // Check DNS resolution
    if (!(await checkDNS(domain))) {
        console.log(`❌ [Worker ${process.pid}] DNS resolution failed for ${domain}`);
        return {
            domain,
            list_number: listNumber,
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

        console.log(`🔍 [Worker ${process.pid}] Response: ${status} - ${finalUrl}`);

        // Check if the response status is acceptable.
        if (!ACCEPTED_STATUS_CODES.includes(status)) {
            return {
                domain,
                list_number: listNumber,
                status: "error",
                error_reason: `Unaccepted status code (${status})`,
                pageSize: 0,
                final_url: finalUrl,
                language
            };
        }

        // Filter out URLs with blocked terms or specific subdomain patterns.
        if (FILTERED_TERMS.some(term => finalUrl.includes(term)) || WW_SUBDOMAIN_REGEX.test(finalUrl)) {
            return {
                domain,
                list_number: listNumber,
                status: "error",
                error_reason: "Filtered (Final URL contains a blocked term or ww## subdomain)",
                pageSize: 0,
                final_url: finalUrl,
                language
            };
        }

        // Validate the Content-Language header if present.
        const languageHeader = response.headers.get("content-language");
        if (languageHeader) {
            language = languageHeader.toLowerCase();
            if (!ALLOWED_LANGUAGES.includes(language)) {
                return {
                    domain,
                    list_number: listNumber,
                    status: "error",
                    error_reason: `Bad language header (${language})`,
                    pageSize: 0,
                    final_url: finalUrl,
                    language
                };
            }
        }

        // Determine the page size using either the Content-Length header or the actual content size.
        const contentLength = response.headers.get("content-length");
        const htmlContent = await response.text();
        pageSize = contentLength ? parseInt(contentLength, 10) : Buffer.byteLength(htmlContent, "utf-8");

        if (!pageSize || isNaN(pageSize)) {
            pageSize = 0;
        }

        // Validate page size limits.
        if (pageSize < MIN_PAGE_SIZE) {
            return {
                domain,
                list_number: listNumber,
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
                list_number: listNumber,
                status: "error",
                error_reason: `Page size too large (> ${MAX_PAGE_SIZE} bytes)`,
                pageSize,
                final_url: finalUrl,
                language
            };
        }

        // Check for HTML content patterns indicating a parking page.
        // Check for HTML content patterns indicating a parking page.
        let detectedTerm = null;

        // First, check for strict terms
        for (const term of HTML_SCRAPE_TERMS.strict) {
            if (htmlContent.includes(term)) {
                detectedTerm = term;
                break;
            }
        }

        // If no strict term was found, check the regex patterns
        if (!detectedTerm) {
            for (const regex of HTML_SCRAPE_TERMS.regex) {
                const match = htmlContent.match(regex);
                if (match) {
                    detectedTerm = match[0];
                    break;
                }
            }
        }

        if (detectedTerm) {
            console.log(`❌ [Worker ${process.pid}] ${domain} → Skipped (Parking Page Detected: ${detectedTerm})`);
            return {
                domain,
                list_number: listNumber,
                status: "error",
                error_reason: `Parking page detected: "${detectedTerm}"`,
                pageSize,
                final_url: finalUrl,
                language
            };
        }

        console.log(`✅ [Worker ${process.pid}] Completed: ${domain} → Status: ${status}, Page Size: ${pageSize} bytes, Final URL: ${finalUrl}`);

        return {
            domain,
            list_number: listNumber,
            status,
            pageSize,
            final_url: finalUrl,
            language
        };
    } catch (error) {
        return {
            domain,
            list_number: listNumber,
            status: "error",
            error_reason: error.message,
            pageSize: 0,
            final_url: "N/A",
            language
        };
    }
}

workerpool.worker({ checkWebsite });