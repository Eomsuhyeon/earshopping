const express = require("express");
const config = require("../config");
const { searchCache } = require("../services/cacheService");

const router = express.Router();

router.get("/status", (req, res) => {
  res.json({
    groqConnected: config.groq.connected,
    geminiConnected: config.gemini.connected,
    openrouterConnected: config.openrouter.connected,
    ebayConnected: config.ebay.connected,
    ebayEnv: config.ebay.env,
    cacheSize: searchCache.size,
    nodeEnv: config.nodeEnv
  });
});

module.exports = router;
