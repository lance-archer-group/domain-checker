// badDocsService.js

const { MongoClient } = require('mongodb');

// In-memory queue to hold bad docs
let queue = [];
let mongoClient = null;
let threshold = 100; // default threshold for immediate processing
let processingInterval = 10000; // default interval: 10 seconds
let timer = null;

/**
 * Initializes the Bad Docs Service.
 * @param {Object} config - Configuration object.
 * @param {MongoClient} config.client - A connected MongoClient instance.
 * @param {number} [config.threshold=100] - The number of docs at which to trigger immediate processing.
 * @param {number} [config.interval=10000] - The processing interval in milliseconds.
 */
function initBadDocsService({ client, threshold: thresh = 100, interval = 10000 }) {
  mongoClient = client;
  threshold = thresh;
  processingInterval = interval;
  timer = setInterval(processQueue, processingInterval);
  console.log(`BadDocsService initialized with threshold=${threshold} and interval=${processingInterval}ms`);
}

/**
 * Processes the accumulated queue by performing an unordered bulk upsert into the MongoDB failed_domains collection.
 */
async function processQueue() {
  if (!mongoClient) {
    console.error("BadDocsService not initialized: MongoClient is not set.");
    return;
  }
  if (queue.length === 0) return;

  // Take a snapshot of the current queue and clear it
  const docsToProcess = queue.slice();
  queue = [];

  try {
    const db = mongoClient.db("Archer_Group");
    const failedDomainsCollection = db.collection("failed_domains");

    // Build bulk operations for each doc
    const bulkOps = docsToProcess.map(doc => ({
      updateOne: {
        filter: { domain: doc.domain.toLowerCase() },
        update: {
          $set: { ...doc, domain: doc.domain.toLowerCase(), updatedAt: new Date() },
          $setOnInsert: { createdAt: new Date() }
        },
        upsert: true
      }
    }));

    if (bulkOps.length > 0) {
      const result = await failedDomainsCollection.bulkWrite(bulkOps, { ordered: false });
      console.log(`BadDocsService: Processed ${docsToProcess.length} docs. Upserted: ${result.upsertedCount}, Matched: ${result.matchedCount}`);
    }
  } catch (err) {
    console.error("BadDocsService: Error processing queue:", err);
    // Optionally, re-add the docs to the queue if processing fails
    queue = docsToProcess.concat(queue);
  }
}

/**
 * Adds an array of bad docs to the processing queue.
 * @param {Array} badResults - Array of bad doc objects to be upserted.
 */
function addResultsQueue(badResults) {
  if (!Array.isArray(badResults)) {
    console.error("addResultsQueue expects an array of bad docs.");
    return;
  }
  queue.push(...badResults);
  console.log(`BadDocsService: Added ${badResults.length} docs to queue. Total in queue: ${queue.length}`);
  
  // Process immediately if the queue size exceeds the threshold
  if (queue.length >= threshold) {
    processQueue();
  }
}

module.exports = {
  initBadDocsService,
  addResultsQueue
};