const express = require('express');
const leaderboardController = require('../controllers/leaderboardController');
const { requireAuth } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/rank/:metric', requireAuth, leaderboardController.getUserRank);
router.get('/:metric', leaderboardController.getLeaderboard);

module.exports = router;
