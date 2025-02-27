const workerpool = require("workerpool");
const { fetch } = require("undici");
const dns = require("dns").promises;

// Page size limits
const MIN_PAGE_SIZE = 1500;
const MAX_PAGE_SIZE = 5 * 1024 * 1024;

// Terms to filter out in final URL
const FILTERED_TERMS = [
    "domain", "atom.com", "dynadot.com", "afternic", "parking", "sedo", 
    ".mx", "amazon.com", "ebay.com", "etsy.com", "allstate.com", "slicelife.com",
    "placester.com", "dignitymemorial.com", "car-part.com", "raymondjames.com",
    "paparazziaccessories.com", "proagentwebsites.com", "vacationstogo.com",
    "vacasa.com", "marriott.com", "intermountainhealthcare.org", "remax.com",
    "ets.org", "wyndhamhotels.com", "sawblade.com", "visahq.com", 
    "resortvacationstogo.com", ".uk", ".de", ".ru", ".ch", ".nl", ".it", 
    ".fr", ".se", ".cn", ".pl", ".eu", ".br", ".jp", ".au","clickfunnels.com","chaturbate.com","instagram.com",
    "zoneiraq.com"
];; // Same as before

// Define Allowed Languages
const ALLOWED_LANGUAGES = ["en", "en-us"];

// Regex for `ww##.` subdomains
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
    if (!domainData || !domainData.domain || !domainData.list_number) return { domain: "unknown", list_number: "unknown", status: "error", error_reason: "Invalid domain data", pageSize: 0, final_url: "N/A", language: "N/A" };

    const domain = domainData.domain.trim();
    let finalUrl = `http://${domain}`, language = "N/A";

    if (!(await checkDNS(domain))) return { domain, list_number: domainData.list_number, status: "error", error_reason: "DNS resolution failed", pageSize: 0, final_url: "N/A", language };

    try {
        const response = await fetch(finalUrl, { method: "GET", headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
        finalUrl = response.url.toLowerCase();

        if (FILTERED_TERMS.some(term => finalUrl.includes(term)) || WW_SUBDOMAIN_REGEX.test(finalUrl)) return { domain, list_number: domainData.list_number, status: "error", error_reason: "Blocked", pageSize: 0, final_url: finalUrl, language };

        language = response.headers.get("content-language") || "N/A";

        return { domain, list_number: domainData.list_number, status: response.status, pageSize: parseInt(response.headers.get("content-length")) || 0, final_url: finalUrl, language };
    } catch (error) {
        return { domain, list_number: domainData.list_number, status: "error", error_reason: error.message, pageSize: 0, final_url: "N/A", language };
    }
}

workerpool.worker({ checkWebsite });