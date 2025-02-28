require("dotenv").config();
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
const { MongoClient } = require("mongodb"); // MongoDB driver

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
    limits: { fileSize: 20 * 1024 * 1024 }, // 5MB
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

/**
 * Upload CSV processing results to MongoDB.
 * Good results are inserted into collection "valid_domains",
 * and bad results into "failed_domains", within database "Archer_Group".
 *
 * @param {Array} goodResults - Array of good result objects.
 * @param {Array} badResults - Array of bad result objects.
 */
async function uploadToMongoDB(goodResults, badResults) {
    const client = new MongoClient(process.env.MONGODB_URI);
    try {
        await client.connect();
        const db = client.db("Archer_Group");

        if (goodResults.length > 0) {
            const validDomainsCollection = db.collection("valid_domains");
            const bulkOps = goodResults.map(doc => ({
                updateOne: {
                    filter: { domain: doc.domain.toLowerCase() },
                    update: {
                        $set: {
                            ...doc,
                            domain: doc.domain.toLowerCase(), // normalize domain
                            updatedAt: new Date()
                        },
                        $setOnInsert: { createdAt: new Date() }
                    },
                    upsert: true
                }
            }));
            const result = await validDomainsCollection.bulkWrite(bulkOps);
            console.log(`✅ Upserted ${result.upsertedCount} good domains to MongoDB, matched ${result.matchedCount}`);
        }
        if (badResults.length > 0) {
            const failedDomainsCollection = db.collection("failed_domains");
            const bulkOps = badResults.map(doc => ({
                updateOne: {
                    filter: { domain: doc.domain.toLowerCase() },
                    update: {
                        $set: {
                            ...doc,
                            domain: doc.domain.toLowerCase(),
                            updatedAt: new Date()
                        },
                        $setOnInsert: { createdAt: new Date() }
                    },
                    upsert: true
                }
            }));
            const result = await failedDomainsCollection.bulkWrite(bulkOps);
            console.log(`✅ Upserted ${result.upsertedCount} bad domains to MongoDB, matched ${result.matchedCount}`);
        }
    } catch (err) {
        console.error("❌ Error uploading to MongoDB:", err);
    } finally {
        await client.close();
    }
}

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
                            ? goodResults.push(data)
                            : badResults.push(data);
                    } else {
                        badResults.push({
                            domain: "unknown",
                            list_number: "unknown",
                            status: "error",
                            error_reason: "Worker thread failed",
                            pageSize: 0,
                            final_url: "N/A",
                            language: "N/A"
                        });
                    }
                });
                // Log counts of good and bad rows here:
                console.log(`Good rows count: ${goodResults.length}`);
                console.log(`Bad rows count: ${badResults.length}`);

                // Write CSVs with custom headers:
                // For good CSV, omit error_reason and use status instead.
                writeCSV(goodFile, goodResults, ["domain", "list_number", "status", "pageSize", "final_url", "language"]);
                // For bad CSV, keep the error_reason column.
                writeCSV(badFile, badResults, ["domain", "list_number", "status", "pageSize", "error_reason", "final_url", "language"]);

                // Upload results to MongoDB.
                await uploadToMongoDB(goodResults, badResults);
                resolve();
            })
            .on("error", reject);
    });
}

// ✅ Function to write CSV results with custom headers
function writeCSV(filename, data, headers) {
    const ws = fs.createWriteStream(filename);
    csv.write(data, { headers }).pipe(ws);
}

// ✅ Start the server
app.listen(PORT, async () => {
    console.log(`✅ Server running at: http://${await getPublicIP()}:${PORT}`);
});