const express = require("express");
const multer = require("multer");
const fs = require("fs");
const csv = require("fast-csv");
const { Worker } = require("worker_threads");
const os = require("os");
const path = require("path");

const app = express();
const PORT = 3000;

// File storage setup
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


// Number of worker threads (set to number of CPU cores)
const NUM_WORKERS = os.cpus().length;

// Function to split domains into chunks
function splitIntoChunks(arr, numChunks) {
    const chunkSize = Math.ceil(arr.length / numChunks);
    return Array.from({ length: numChunks }, (_, i) => arr.slice(i * chunkSize, (i + 1) * chunkSize));
}

// Function to process CSV
async function processCSV(inputFile, outputDir) {
    const domains = [];

    return new Promise((resolve, reject) => {
        fs.createReadStream(inputFile)
            .pipe(csv.parse({ headers: true }))
            .on("data", row => domains.push(row.domain))
            .on("end", async () => {
                console.log(`Processing ${domains.length} domains using ${NUM_WORKERS} workers...`);

                const chunks = splitIntoChunks(domains, NUM_WORKERS);
                const workers = chunks.map(chunk => new Worker("./prescreen_worker.js", { workerData: { domains: chunk } }));

                const results = [];
                workers.forEach(worker => {
                    worker.on("message", data => results.push(...data));
                    worker.on("error", err => console.error(`Worker error: ${err}`));
                    worker.on("exit", code => {
                        if (code !== 0) console.error(`Worker stopped with exit code ${code}`);
                    });
                });

                // Wait for all workers to complete
                await Promise.all(workers.map(worker => new Promise(res => worker.on("exit", res))));

                // Split results into good and bad
                const goodResults = results.filter(result => !result.parked);
                const badResults = results.filter(result => result.parked);

                // Write results to CSV
                writeCSV(path.join(outputDir, "goodOut.csv"), goodResults);
                writeCSV(path.join(outputDir, "badOut.csv"), badResults);

                console.log(`Processing complete: ${goodResults.length} good, ${badResults.length} bad.`);
                resolve();
            })
            .on("error", reject);
    });
}

// Function to write results to CSV
function writeCSV(filename, data) {
    const ws = fs.createWriteStream(filename);
    csv.write(data, { headers: true }).pipe(ws);
}

// API Endpoint: Upload CSV
app.post("/upload", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const inputFile = req.file.path;
    const outputDir = "results";

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir);
    }

    try {
        await processCSV(inputFile, outputDir);
        res.json({ message: "Processing complete. Download results below.", goodCsv: "/download/goodOut.csv", badCsv: "/download/badOut.csv" });
    } catch (error) {
        console.error("Error processing CSV:", error);
        res.status(500).json({ error: "Failed to process CSV" });
    }
});

// API Endpoint: Download results
app.get("/download/:filename", (req, res) => {
    const filePath = path.join(__dirname, "results", req.params.filename);
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).json({ error: "File not found" });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
