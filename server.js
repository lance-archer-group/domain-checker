const express = require("express");
const multer = require("multer");
const fs = require("fs");
const csv = require("fast-csv");
const workerpool = require("workerpool");
const os = require("os");
const path = require("path");
const { fetch } = require("undici");
const dns = require("dns").promises;

const app = express();
const PORT = process.env.PORT || 3000;
const pool = workerpool.pool("./prescreen_worker.js", { maxWorkers: os.cpus().length });

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

// ✅ Log system resources
const logSystemResources = () => {
    const totalMemory = os.totalmem() / (1024 * 1024); // Convert to MB
    const freeMemory = os.freemem() / (1024 * 1024); // Convert to MB
    const cpuCores = os.cpus().length;
    console.log("🖥️ System Resources:");
    console.log(`   🧠 Total Memory: ${totalMemory.toFixed(2)} MB`);
    console.log(`   🏋️ Free Memory: ${freeMemory.toFixed(2)} MB`);
    console.log(`   🔢 CPU Cores: ${cpuCores}`);
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
        const publicIP = await getPublicIP(); // ✅ Get public IP for response links
        const serverAddress = `http://${publicIP}:${PORT}`;

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
        res.setHeader("Content-Disposition", `attachment; filename=\"${req.params.filename}\"`);
        res.setHeader("Content-Type", "application/octet-stream");
        res.download(filePath);
    } else {
        res.status(404).json({ error: "File not found" });
    }
});

// ✅ Function to process CSV with worker pool
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
                console.log(`🚀 Processing ${domains.length} domains with worker pool...`);
                logSystemResources();

                // ✅ Process all domains concurrently using worker pool
                const tasks = domains.map(domain => pool.exec("checkWebsite", [domain],{ timeout: 10000 }));
                const results = await Promise.allSettled(tasks);

                // ✅ Process results
                const goodResults = results.filter(res => res.status === "fulfilled" && !res.value.parked).map(res => res.value);
                const badResults = results.filter(res => res.status === "fulfilled" && res.value.parked).map(res => res.value);

                writeCSV(path.join(outputDir, "goodOut.csv"), goodResults);
                writeCSV(path.join(outputDir, "badOut.csv"), badResults);

                console.log(`📁 Results saved: ${goodResults.length} good, ${badResults.length} bad.`);
                resolve();
            })
            .on("error", reject);
    });
}

// ✅ Start the server and log correct hostname/IP
app.listen(PORT, async () => {
    const hostname = getHostname();
    const publicIP = await getPublicIP();
    
    console.log(`✅ Server running at:`);
    console.log(`   🌍 Hostname: ${hostname}`);
    console.log(`   🌐 Public IP: ${publicIP}`);
    console.log(`   📡 Listening on: http://0.0.0.0:${PORT}`);
    console.log(`   📂 Download Results: http://${publicIP}:${PORT}/download/goodOut.csv`);
    console.log(`   📂 Download Results: http://${publicIP}:${PORT}/download/badOut.csv`);

    logSystemResources();
});