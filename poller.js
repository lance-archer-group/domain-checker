// poller.js
const schedule = require("node-schedule");
const os = require("os");

module.exports = function initPoller({ mongoClient, pool, ALLOWED_LANGUAGES, uploadToMongoDB }) {
  // Cron expression: every minute; adjust as needed.
  const POLL_INTERVAL = "*/1 * * * *";
  let isProcessing = false;

  // Process a batch of domains from the "to_be_scanned" collection.
  async function processBatch() {
    try {
      const db = mongoClient.db("Archer_Group");
      const toBeScannedCollection = db.collection("to_be_scanned");

      // Log which collection we are connecting to and the current time.
      console.log(`[${new Date().toISOString()}] Connected to collection: 'Archer_Group.to_be_scanned'`);

      // Set the batch size equal to the number of CPU cores (or any other desired number)
      const batchSize = os.cpus().length;

      // Retrieve a batch of documents to process.
      const docs = await toBeScannedCollection.find().limit(batchSize).toArray();
      console.log(`[${new Date().toISOString()}] Retrieved batch of ${docs.length} domains from 'to_be_scanned'.`);

      if (docs.length === 0) {
        console.log(`[${new Date().toISOString()}] No documents in 'to_be_scanned' collection.`);
        return;
      }

      // Map each document to a workerpool task using the checkWebsite function.
      const tasks = docs.map(doc => {
        const domainData = {
          domain: doc.domain,
          list_number: doc.list_number
        };
        return pool
          .exec("checkWebsite", [domainData])
          .timeout(10000)
          .catch(error => ({
            domain: domainData.domain,
            list_number: domainData.list_number,
            status: "error",
            error_reason: error.message || "Timeout exceeded",
            pageSize: 0,
            final_url: "N/A",
            language: "N/A"
          }));
      });

      // Wait for all worker tasks to finish.
      const results = await Promise.allSettled(tasks);
      const goodResults = [];
      const badResults = [];

      results.forEach(result => {
        if (result.status === "fulfilled") {
          const data = result.value;
          const normalizedLanguage = data.language.toLowerCase();
          const isAllowedLanguage = (normalizedLanguage === "n/a" || ALLOWED_LANGUAGES.includes(normalizedLanguage));
          if (data.status !== "error" && data.pageSize > 0 && isAllowedLanguage) {
            goodResults.push(data);
          } else {
            badResults.push(data);
          }
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

      // Upload the processed results to MongoDB collections.
      await uploadToMongoDB(goodResults, badResults);

      // Delete the processed documents from "to_be_scanned" using their _id.
      const idsToDelete = docs.map(doc => doc._id);
      if (idsToDelete.length > 0) {
        await toBeScannedCollection.deleteMany({ _id: { $in: idsToDelete } });
        console.log(`[${new Date().toISOString()}] Deleted ${idsToDelete.length} processed documents from 'to_be_scanned'.`);
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error in processBatch:`, error);
    }
  }

  // Polling function to ensure one batch is processed at a time.
  async function pollToBeScanned() {
    console.log(`[${new Date().toISOString()}] Scheduled pollToBeScanned job triggered.`);
    if (isProcessing) {
      console.log(`[${new Date().toISOString()}] Previous batch is still processing. Skipping this interval.`);
      return;
    }
    isProcessing = true;
    try {
      await processBatch();
    } finally {
      isProcessing = false;
    }
  }

  // Schedule the polling using node-schedule.
  schedule.scheduleJob(POLL_INTERVAL, pollToBeScanned);
  console.log(`[${new Date().toISOString()}] Poller scheduled with interval: ${POLL_INTERVAL}`);
};