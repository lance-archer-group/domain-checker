const express = require("express");
const multer = require("multer");
const fs = require("fs");
const csv = require("fast-csv");
const { Worker } = require("worker_threads");
const os = require("os");
const path = require("path");
const dns = require("dns");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000; // ✅ Use Coolify-assigned port if available

// ✅ Get the actual hostname (useful for logs)
const getHostname = () => os.hostname();

// ✅ Get public IP address (useful for external reporting)
const getPublicIP = async () => {
    try {
        const response = await axios.get("https://api64.ipify.org?format=json");
        return response.data.ip;
    } catch (error) {
        return "Unknown IP (No Internet Access)";
    }
};

// ✅ Configure file upload (CSV only)
const upload = multer({
    dest: "uploads/",
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype !== "text/csv") {
            return cb(new Error("Only CSV files are allowed"), false);
        }
        cb(null, true);
    },
});

// ✅ Set optimal number of workers
const NUM_WORKERS = Math.min(8, os.cpus().length);

// ✅ Function to split data into chunks
function splitIntoChunks(arr, numChunks) {
    const chunkSize = Math.ceil(arr.length / numChunks);
    return Array.from({ length: numChunks }, (_, i) => arr.slice(i * chunkSize, (i + 1) * chunkSize));
}

// ✅ Function to process CSV with workers
async function processCSV(inputFile, outputDir) {
    const domains = [];

    return new Promise((resolve, reject) => {
        fs.createReadStream(inputFile)
            .pipe(csv.parse({ headers: true }))
            .on("data", row => {
                if (row.domain && row.list_number) {
                    domains.push({ domain: row.domain.trim(), list_number: row.list_number.trim() });
                }
            })
            .on("end", async () => {
                console.log(`🚀 Processing ${domains.length} domains with ${NUM_WORKERS} workers...`);

                const chunks = splitIntoChunks(domains, NUM_WORKERS);
                const workers = [];
                let completedWorkers = 0;
                let results = [];

                chunks.forEach((chunk, index) => {
                    if (chunk.length === 0) return;

                    console.log(`🟢 Worker ${index + 1} assigned ${chunk.length} domains`);
                    const worker = new Worker("./prescreen_worker.js", { workerData: { domains: chunk } });

                    worker.on("message", (data) => {
                        results = results.concat(data);
                    });

                    worker.on("exit", (code) => {
                        completedWorkers++;
                        console.log(`🔵 Worker ${index + 1} completed. Exit Code: ${code}`);

                        if (completedWorkers === workers.length) {
                            console.log("✅ All workers finished processing.");

                            // ✅ Write results to CSV
                            const goodResults = results.filter(result => !result.parked);
                            const badResults = results.filter(result => result.parked);

                            writeCSV(path.join(outputDir, "goodOut.csv"), goodResults);
                            writeCSV(path.join(outputDir, "badOut.csv"), badResults);

                            console.log(`📁 Results saved: ${goodResults.length} good, ${badResults.length} bad.`);
                            resolve();
                        }
                    });

                    worker.on("error", (err) => {
                        console.error(`❌ Worker ${index + 1} error:`, err);
                    });

                    workers.push(worker);
                });
            })
            .on("error", reject);
    });
}

// ✅ Function to write CSV results
function writeCSV(filename, data) {
    const ws = fs.createWriteStream(filename);
    csv.write(data, { headers: true }).pipe(ws);
}

// ✅ API Endpoint: Upload CSV
app.post("/upload", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const inputFile = req.file.path;
    const outputDir = "results";

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir);
    }

    try {
        await processCSV(inputFile, outputDir);
        const serverAddress = `http://${req.hostname}:${PORT}`;

        res.json({
            message: "Processing complete. Download results below.",
            goodCsv: `${serverAddress}/download/goodOut.csv`,
            badCsv: `${serverAddress}/download/badOut.csv`
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

// ✅ Start the server and log correct hostname/IP
app.listen(PORT, async () => {
    const hostname = getHostname();
    const publicIP = await getPublicIP();
    
    console.log(`✅ Server running at:`);
    console.log(`   🌍 Hostname: ${hostname}`);
    console.log(`   🌐 Public IP: ${publicIP}`);
    console.log(`   📡 Listening on: http://0.0.0.0:${PORT}`);
});
