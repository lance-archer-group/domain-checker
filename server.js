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
const COMPETERA_URL = "http://z4gc0cgo4c08w48gwo44ks48.csa.competera.com:3997/api/domains/upload-csv";

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

// ✅ Send CSV URLs to Bubble API
async function sendToBubble(fileType, filePath) {
    try {
        const publicIP = await getPublicIP();
        const fileUrl = `http://${publicIP}:${PORT}/download/${path.basename(filePath)}`;
        
        console.log(`📡 Sending ${fileType} file URL to Bubble API...`);
        console.log("🔹 URL:", fileUrl);

        const payload = { file: fileUrl };

        const response = await axios.post(BUBBLE_API_URL, payload, {
            headers: {
                "Content-Type": "application/json",
            },
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

/**
 * ✅ Create a new CSV containing only domain and list_number
 *    from the Good CSV, so Competera receives exactly 2 columns
 */
async function createCompeteraCSV(fullCsvPath) {
    return new Promise((resolve, reject) => {
        const twoColumnData = [];
        // We'll name the file the same as good CSV but with "_competera.csv" suffix.
        // Or you can choose another naming scheme.
        const baseName = path.basename(fullCsvPath, path.extname(fullCsvPath));
        const competeraCsvPath = path.join(resultsDir, `${baseName}_competera.csv`);

        fs.createReadStream(fullCsvPath)
            .pipe(csv.parse({ headers: true }))
            .on("data", (row) => {
                // Keep only the two columns we need:
                twoColumnData.push({
                    domain: row.domain,
                    list_number: row.list_number,
                });
            })
            .on("end", () => {
                const ws = fs.createWriteStream(competeraCsvPath);
                // Write out domain, list_number only:
                csv.write(twoColumnData, { headers: ["domain", "list_number"] })
                   .pipe(ws)
                   .on("finish", () => {
                       console.log(`✅ Created Competera CSV: ${competeraCsvPath}`);
                       resolve(competeraCsvPath);
                   })
                   .on("error", reject);
            })
            .on("error", reject);
    });
}

// ✅ Upload the two-column CSV to Competera
// async function uploadGoodCSVToCompetera(filePath) {
//     try {
//         console.log(`📡 Uploading 2-column Good CSV to Competera: ${filePath}`);

//         const formData = new FormData();
//         // Replace 'file' with the exact field name the Competera endpoint expects:
//         formData.append("domains", fs.createReadStream(filePath));

//         const response = await axios.post(COMPETERA_URL, formData, {
//             headers: {
//                 ...formData.getHeaders(),
//             },
//         });

//         console.log("✅ Good CSV successfully uploaded to Competera:", response.status);
//         console.log("🔹 Response Data:", response.data);
//     } catch (error) {
//         console.error("❌ Error uploading Good CSV to Competera:", error.message);
//         if (error.response) {
//             console.error("🔸 Status:", error.response.status);
//             console.error("🔸 Response Data:", error.response.data);
//         }
//     }
// }

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
    const baseFilename = path.basename(req.file.originalname, path.extname(req.file.originalname));

    // Output CSVs
    const goodFile = path.join(resultsDir, `${baseFilename}_good.csv`);
    const badFile = path.join(resultsDir, `${baseFilename}_bad.csv`);

    try {
        // Process the CSV (creates goodFile & badFile)
        await processCSV(inputFile, goodFile, badFile);

        // Send URLs to Bubble
        await sendToBubble("good", goodFile);
        await sendToBubble("bad", badFile);

        // Create a 2-column version of the "good" CSV (domain, list_number) only
        //const competeraCsv = await createCompeteraCSV(goodFile);

        // Upload that 2-column CSV to Competera
        // await uploadGoodCSVToCompetera(competeraCsv);

        // Return result links
        const publicIP = await getPublicIP();
        const serverAddress = `http://${publicIP}:${PORT}`;

        res.json({
            message: "Processing complete. Download results below.",
            goodCsv: `${serverAddress}/download/${path.basename(goodFile)}`,
            badCsv: `${serverAddress}/download/${path.basename(badFile)}`,
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
// Define an array of accepted English-based language codes
const ALLOWED_LANGUAGES = ["en", "en-us", "en-gb", "en-ca", "en-au", "en-nz", "en-in"];

async function processCSV(inputFile, goodFile, badFile) {
    return new Promise((resolve, reject) => {
        const tasks = [];

        fs.createReadStream(inputFile)
            .pipe(csv.parse({ headers: true }))
            .on("data", async (row) => {
                if (row.domain && row.list_number) {
                    const domainData = {
                        domain: row.domain.trim(),
                        list_number: row.list_number.trim(),
                    };

                    const task = pool.exec("checkWebsite", [domainData])
                        .timeout(10000)
                        .catch(() => ({
                            domain: domainData.domain,
                            list_number: domainData.list_number,
                            status: "error",
                            error_reason: "Timeout exceeded",
                            pageSize: 0,
                            final_url: "N/A",
                            language: "N/A", // Default language
                        }));

                    tasks.push(task);
                }
            })
            .on("end", async () => {
                console.log(`🚀 Processing ${tasks.length} domains with worker pool...`);

                const results = await Promise.allSettled(tasks);
                const goodResults = [];
                const badResults = [];

                results.forEach((result) => {
                    if (result.status === "fulfilled") {
                        const data = result.value;

                        // Normalize language (convert to lowercase)
                        const normalizedLanguage = data.language.toLowerCase();

                        // Allow "N/A" as a valid language
                        const isAllowedLanguage = (normalizedLanguage === "n/a" || ALLOWED_LANGUAGES.includes(normalizedLanguage));

                        // ✅ Categorize domain correctly
                        if (
                            data.status !== "error" &&  // ✅ No error status
                            data.pageSize > 0 &&        // ✅ Valid page size
                            isAllowedLanguage           // ✅ Language is either "N/A" or allowed
                        ) {
                            goodResults.push(data);
                        } else {
                            badResults.push(data);
                        }
                    } else {
                        // ❌ Worker thread failure, move to badResults
                        badResults.push({
                            domain: "unknown",
                            list_number: "unknown",
                            status: "error",
                            error_reason: "Worker thread failed",
                            pageSize: 0,
                            final_url: "N/A",
                            language: "N/A",
                        });
                    }
                });

                // ✅ Sort results alphabetically before writing CSV
                goodResults.sort((a, b) => a.domain.localeCompare(b.domain));
                badResults.sort((a, b) => a.domain.localeCompare(b.domain));

                // ✅ Write sorted CSVs
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
    csv.write(data, { 
        headers: ["domain", "list_number", "status", "pageSize", "error_reason", "final_url", "language"],
        quote: '"',  // Only quote when necessary
        escape: '"'  // Properly escape quotes
    })
    .pipe(ws);
}



// ✅ Schedule deletion of old files (every day at midnight)
schedule.scheduleJob("0 0 * * *", () => {
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    fs.readdir(resultsDir, (err, files) => {
        if (err) {
            return console.error("❌ Error reading results directory:", err);
        }

        files.forEach((file) => {
            const filePath = path.join(resultsDir, file);
            fs.stat(filePath, (err, stats) => {
                if (err) {
                    return console.error("❌ Error getting file stats:", err);
                }
                // If file is older than 1 week, delete it
                if (stats.mtimeMs < oneWeekAgo) {
                    fs.unlink(filePath, (err) => {
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
