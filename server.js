const express = require("express");
const multer = require("multer");
const fs = require("fs");
const csv = require("fast-csv");
const workerpool = require("workerpool");
const os = require("os");
const path = require("path");
const { fetch } = require("undici");
const dns = require("dns").promises;
const schedule = require("node-schedule");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;
const pool = workerpool.pool(path.join(__dirname, "prescreen_worker.js"), { maxWorkers: os.cpus().length });
const BUBBLE_API_URL = "https://d132.bubble.is/site/dataorchard/version-test/api/1.1/wf/webhookfile";

// ⭐️ Ensure "results" folder exists on startup
const resultsDir = "results";
if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir);
}

// ✅ Get public IP address
const getPublicIP = async () => {
    try {
        const response = await fetch("https://api64.ipify.org?format=json");
        const data = await response.json();
        return data.ip;
    } catch (error) {
        return "Unknown IP (No Internet Access)";
    }
};

// ✅ Send CSV URLs to Bubble API
async function sendToBubble(fileType, filePath) {
    try {
        const publicIP = await getPublicIP();
        const fileUrl = `http://${publicIP}:${PORT}/download/${path.basename(filePath)}`;

        console.log(`📡 Sending ${fileType} file URL to Bubble API: ${fileUrl}`);

        const response = await axios.post(BUBBLE_API_URL, { file: fileUrl }, {
            headers: { "Content-Type": "application/json" }
        });

        console.log(`✅ Successfully sent ${fileType} file URL to Bubble API: ${response.status}`);
    } catch (error) {
        console.error(`❌ Error sending ${fileType} file URL to Bubble API:`, error.message);
    }
}

// ✅ Configure file upload (CSV only)
const upload = multer({
    dest: "uploads/",
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        file.mimetype === "text/csv" ? cb(null, true) : cb(new Error("Only CSV files are allowed"), false);
    }
});

// ✅ API Endpoint: Upload CSV
app.post("/upload", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const inputFile = req.file.path;
    const baseFilename = path.basename(req.file.originalname, path.extname(req.file.originalname));
    const goodFile = path.join(resultsDir, `${baseFilename}_good.csv`);
    const badFile = path.join(resultsDir, `${baseFilename}_bad.csv`);

    try {
        await processCSV(inputFile, goodFile, badFile);

        await sendToBubble("good", goodFile);
        await sendToBubble("bad", badFile);

        const publicIP = await getPublicIP();
        res.json({
            message: "Processing complete. Download results below.",
            goodCsv: `http://${publicIP}:${PORT}/download/${path.basename(goodFile)}`,
            badCsv: `http://${publicIP}:${PORT}/download/${path.basename(badFile)}`,
        });
    } catch (error) {
        console.error("❌ Error processing CSV:", error);
        res.status(500).json({ error: "Failed to process CSV" });
    }
});

// ✅ API Endpoint: Download results
app.get("/download/:filename", (req, res) => {
    const filePath = path.join(__dirname, "results", req.params.filename);
    fs.existsSync(filePath) ? res.download(filePath) : res.status(404).json({ error: "File not found" });
});

// ✅ Define Allowed Languages
const ALLOWED_LANGUAGES = ["en", "en-us"];

// ✅ Function to process CSV
async function processCSV(inputFile, goodFile, badFile) {
    return new Promise((resolve, reject) => {
        const tasks = [];

        fs.createReadStream(inputFile)
            .pipe(csv.parse({ headers: true }))
            .on("data", (row) => {
                if (row.domain && row.list_number) {
                    const domainData = { domain: row.domain.trim(), list_number: row.list_number.trim() };
                    tasks.push(pool.exec("checkWebsite", [domainData]).timeout(10000).catch(() => ({
                        domain: domainData.domain, list_number: domainData.list_number,
                        status: "error", error_reason: "Timeout exceeded",
                        pageSize: 0, final_url: "N/A", language: "N/A"
                    })));
                }
            })
            .on("end", async () => {
                const results = await Promise.allSettled(tasks);
                const goodResults = [];
                const badResults = [];

                results.forEach((result) => {
                    if (result.status === "fulfilled") {
                        const data = result.value;
                        const normalizedLanguage = data.language.toLowerCase();
                        const isAllowedLanguage = (normalizedLanguage === "n/a" || ALLOWED_LANGUAGES.includes(normalizedLanguage));

                        (data.status !== "error" && data.pageSize > 0 && isAllowedLanguage)
                            ? goodResults.push(data) : badResults.push(data);
                    } else {
                        badResults.push({ domain: "unknown", list_number: "unknown", status: "error", error_reason: "Worker thread failed", pageSize: 0, final_url: "N/A", language: "N/A" });
                    }
                });

                writeCSV(goodFile, goodResults);
                writeCSV(badFile, badResults);
                resolve();
            })
            .on("error", reject);
    });
}

// ✅ Function to write CSV results
function writeCSV(filename, data) {
    const ws = fs.createWriteStream(filename);
    csv.write(data, { headers: ["domain", "list_number", "status", "pageSize", "error_reason", "final_url", "language"] }).pipe(ws);
}

// ✅ Start the server
app.listen(PORT, async () => {
    console.log(`✅ Server running at: http://${await getPublicIP()}:${PORT}`);
});
