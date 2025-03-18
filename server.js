// server.js
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
const { MongoClient } = require("mongodb");

const app = express();
const PORT = process.env.PORT || 3000;
const pool = workerpool.pool(path.join(__dirname, "prescreen_worker.js"), { maxWorkers: os.cpus().length * 2});
const BUBBLE_API_URL = "https://d132.bubble.is/site/dataorchard/version-test/api/1.1/wf/webhookfile";

// Ensure "results" folder exists on startup.
const resultsDir = "results";
if (!fs.existsSync(resultsDir)) {
  fs.mkdirSync(resultsDir);
}

const mongoClient = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 25 });
async function initializeMongoClient() {
  try {
    await mongoClient.connect();
    console.log("✅ MongoDB connected and connection pool initialized");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
    process.exit(1);
  }
}
initializeMongoClient();
const { initBadDocsService, addResultsQueue } = require('./badDocsService');
initBadDocsService({ client: mongoClient, threshold: 100, interval: 10000 });
// Define ALLOWED_LANGUAGES.
const ALLOWED_LANGUAGES = ["en", "en-us"];
async function recordListNumberStats(aggregatedCounts) {
  const db = mongoClient.db("Archer_Group");
  const statsCollection = db.collection("domain_scan_events"); // time-series or regular

  const now = new Date();
  const docs = Object.entries(aggregatedCounts).map(([listNumber, counts]) => ({
    list_number: listNumber,
    good_count: counts.good,
    bad_count: counts.bad,
    createdAt: now
  }));

  if (docs.length > 0) {
    await statsCollection.insertMany(docs);
    console.log(`Inserted ${docs.length} stats documents for list_numbers.`);
  }
}
function aggregateCountsByListNumber(goodResults, badResults) {
  const resultMap = {};

  // Count "good"
  for (const doc of goodResults) {
    const ln = doc.list_number;
    if (!resultMap[ln]) {
      resultMap[ln] = { good: 0, bad: 0 };
    }
    resultMap[ln].good++;
  }

  // Count "bad"
  for (const doc of badResults) {
    const ln = doc.list_number;
    if (!resultMap[ln]) {
      resultMap[ln] = resultMap[ln] || { good: 0, bad: 0 };
    }
    resultMap[ln].bad++;
  }

  return resultMap; 
  // Example shape: 
  // {
  //   "LIST123": { good: 2, bad: 1 },
  //   "LIST999": { good: 5, bad: 3 }
  // }
}
// Function to upload results to MongoDB.
async function uploadToMongoDB(goodResults, badResults) {
  try {
    const db = mongoClient.db("Archer_Group");

    // Process good docs synchronously
    if (goodResults.length > 0) {
      const validDomainsCollection = db.collection("valid_domains");
      const bulkOps = goodResults.map(doc => ({
        updateOne: {
          filter: { domain: doc.domain.toLowerCase() },
          update: {
            $set: { ...doc, domain: doc.domain.toLowerCase(), updatedAt: new Date() },
            $setOnInsert: { createdAt: new Date() }
          },
          upsert: true
        }
      }));
      const result = await validDomainsCollection.bulkWrite(bulkOps, { ordered: false });
      console.log(`✅ Upserted ${result.upsertedCount} good domains to MongoDB, matched ${result.matchedCount}`);
    }
  } catch (err) {
    console.error("❌ Error upserting good docs:", err);
  }

  // For bad docs, offload to the badDocsService and do not await its completion.
  if (badResults.length > 0) {
    try {
      const { addResultsQueue } = require('./badDocsService');
      // Fire-and-forget the bad docs upsert
      addResultsQueue(badResults);
    } catch (err) {
      console.error("❌ Error offloading bad docs to the service:", err);
    }
  }

  // Optionally, record aggregated stats (if this operation is fast)
  const aggregatedCounts = aggregateCountsByListNumber(goodResults, badResults);
  await recordListNumberStats(aggregatedCounts);
}

// (Other parts of your server.js, such as CSV processing, file upload endpoints, etc.)

// Import and initialize the poller.
const initPoller = require("./poller");
initPoller({ mongoClient, pool, ALLOWED_LANGUAGES, uploadToMongoDB });
// Endpoint to return the count of documents in the to_be_scanned collection.
app.get("/to_be_scanned", async (req, res) => {
    try {
      const db = mongoClient.db("Archer_Group");
      const count = await db.collection("to_be_scanned").countDocuments();
      res.json({ count });
    } catch (error) {
      console.error("Error fetching count:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });
// Start the server.
app.listen(PORT, async () => {
  const publicIP = await (async () => {
    try {
      const response = await fetch("https://api64.ipify.org?format=json");
      const data = await response.json();
      return data.ip;
    } catch {
      return "Unknown IP (No Internet Access)";
    }
  })();
  console.log(`✅ Server running at: http://${publicIP}:${PORT}`);
});
