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
const FormData = require("form-data");

const app = express();
const PORT = process.env.PORT || 3000;
const pool = workerpool.pool("./prescreen_worker.js", { maxWorkers: os.cpus().length });
const BUBBLE_API_URL = "https://d132.bubble.is/site/dataorchard/version-test/api/1.1/wf/webhookfile";

// ⭐️ Ensure "results" folder exists as soon as the server starts
const resultsDir = "results";
if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir);
}

// ✅ Get the actual hostname (useful for logs)
const getHostname = () => os.hostname();

// ✅ Get public IP address (useful for external reporting)
const getPublicIP = async () => {
    try {
        const response = await fetch("https://api64.ipify.org?format=json");
        const data = await response.json();
        return data.ip;
    } catch (error) {
        return "Unknown IP (No Internet Access)";
    }
};

// ✅ Function to send files to Bubble API (Using FormData)
async function sendToBubble(fileType, filePath) {
    try {
        const publicIP = await getPublicIP();
        const fileUrl = `http://${publicIP}:${PORT}/download/${path.basename(filePath)}`;
        
        console.log(`📡 Sending ${fileType} file URL to Bubble API...`);
        console.log("🔹 URL:", fileUrl);

        const payload = { file: fileUrl };

        const response = await axios.post(BUBBLE_API_URL, payload, {
            headers: {
                "Content-Type": "application/json"
            }
        });

        console.log(`✅ Successfully sent ${fileType} file URL to Bubble API: ${response.status}`);
        console.log("🔹 Response Data:", response.data);
    } catch (error) {
        console.error(`❌ Error sending ${fileType} file URL to Bubble API:`);
        if (error.response) {
            console.error("🔸 Status:", error.response.status);
            console.error("🔸 Response Data:", error.response.data);
        } else {
            console.error("🔸 Error Message:", error.message);
        }
    }
}

// ✅ Configure file upload (CSV only)
const upload = multer({
    dest: "uploads/",
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype !== "text/csv") {
            return cb(new Error("Only CSV files are allowed"), false);
        }
        cb(null, true);
    },
});

// ✅ API Endpoint: Upload CSV
app.post("/upload", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const inputFile = req.file.path;
    const outputDir = "results";
    const baseFilename = path.basename(req.file.originalname, path.extname(req.file.originalname));
    const goodFile = path.join(outputDir, `${baseFilename}_good.csv`);
    const badFile = path.join(outputDir, `${baseFilename}_bad.csv`);

    // Make sure the results folder exists (it will by now, but just in case)
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir);
    }

    try {
        await processCSV(inputFile, goodFile, badFile);
        const publicIP = await getPublicIP();
        const serverAddress = `http://${publicIP}:${PORT}`;

        // ✅ Send files to Bubble API
        await sendToBubble("good", goodFile);
        await sendToBubble("bad", badFile);

        res.json({
            message: "Processing complete. Download results below.",
            goodCsv: `${serverAddress}/download/${path.basename(goodFile)}`,
            badCsv: `${serverAddress}/download/${path.basename(badFile)}`
        });
    } catch (error) {
        console.error("❌ Error processing CSV:", error);
        res.status(500).json({ error: "Failed to process CSV" });
    }
});

// ✅ API Endpoint: Download results
app.get("/download/:filename", (req, res) => {
    const filePath = path.join(__dirname, "results", req.params.filename);

    if (fs.existsSync(filePath)) {
        res.setHeader("Content-Disposition", `attachment; filename="${req.params.filename}"`);
        res.setHeader("Content-Type", "application/octet-stream");
        res.download(filePath);
    } else {
        res.status(404).json({ error: "File not found" });
    }
});

// ✅ Function to process CSV with worker pool
async function processCSV(inputFile, goodFile, badFile) {
    return new Promise((resolve, reject) => {
        const tasks = [];
        
        fs.createReadStream(inputFile)
            .pipe(csv.parse({ headers: true }))
            .on("data", async row => {
                if (row.domain && row.list_number) {
                    const domainData = {
                        domain: row.domain.trim(),
                        list_number: row.list_number.trim()
                    };
                    
                    const task = pool.exec("checkWebsite", [domainData])
                        .timeout(10000)
                        .catch(() => ({
                            domain: domainData.domain,
                            list_number: domainData.list_number,
                            status: "error",
                            error_reason: "Timeout exceeded",
                            parked: true,
                            pageSize: 0,
                            final_url: "N/A"
                        }));
                    
                    tasks.push(task);
                }
            })
            .on("end", async () => {
                console.log(`🚀 Processing ${tasks.length} domains with worker pool...`);
                
                const results = await Promise.allSettled(tasks);
                const goodResults = [];
                const badResults = [];
                
                results.forEach(result => {
                    if (result.status === "fulfilled") {
                        const data = result.value;
                        if (data.status === "error" || data.parked || data.error_reason) {
                            badResults.push(data);
                        } else {
                            goodResults.push(data);
                        }
                    } else {
                        badResults.push({
                            domain: "unknown",
                            list_number: "unknown",
                            status: "error",
                            error_reason: "Worker thread failed",
                            parked: true,
                            pageSize: 0,
                            final_url: "N/A"
                        });
                    }
                });

                writeCSV(goodFile, goodResults);
                writeCSV(badFile, badResults);

                console.log(`📁 Results saved: ${goodResults.length} good, ${badResults.length} bad.`);
                resolve();
            })
            .on("error", reject);
    });
}

// ✅ Function to write CSV results
function writeCSV(filename, data) {
    const ws = fs.createWriteStream(filename);
    csv.write(data, { headers: ["domain", "list_number", "status", "pageSize", "error_reason", "final_url"] })
       .pipe(ws);
}

// ✅ Schedule deletion of old files (every day at midnight)
schedule.scheduleJob("0 0 * * *", () => {
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    // fs.readdir is safe now because the "results" folder definitely exists
    fs.readdir(resultsDir, (err, files) => {
        if (err) {
            return console.error("❌ Error reading results directory:", err);
        }

        files.forEach(file => {
            const filePath = path.join(resultsDir, file);
            fs.stat(filePath, (err, stats) => {
                if (err) {
                    return console.error("❌ Error getting file stats:", err);
                }
                if (stats.mtimeMs < oneWeekAgo) {
                    fs.unlink(filePath, err => {
                        if (err) {
                            console.error("❌ Error deleting file:", err);
                        } else {
                            console.log(`🗑️ Deleted old file: ${file}`);
                        }
                    });
                }
            });
        });
    });
});

// ✅ Start the server and log correct hostname/IP
app.listen(PORT, async () => {
    const hostname = getHostname();
    const publicIP = await getPublicIP();

    console.log(`✅ Server running at:`);
    console.log(`   🌍 Hostname: ${hostname}`);
    console.log(`   🌐 Public IP: ${publicIP}`);
    console.log(`   📡 Listening on: http://${publicIP}:${PORT}`);
});
